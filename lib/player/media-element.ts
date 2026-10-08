import type { MediaSource, SourceKind } from "@/lib/room/types";
import { DRM_MESSAGE, INCOMPATIBLE_MESSAGE, NOT_DIRECT_MESSAGE, describeMediaError } from "@/lib/media/source";
import { Emitter, notAllowed, type MediaInfoSummary, type PlayerAdapter, type PlayerEvent, type PlayerListener } from "@/lib/player/types";
import { PositionClock } from "@/lib/player/script";

export type PlayerOptions = { controls: boolean };

/**
 * The HTMLMediaElement surface shared by <video> and the media-element web
 * components react-player is built on (hls-video, dash-video, youtube-video).
 */
type MediaLike = HTMLElement & {
  src: string;
  controls: boolean;
  playsInline: boolean;
  preload: string;
  play(): Promise<void>;
  pause(): void | Promise<void>;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly buffered?: TimeRanges;
  readonly videoWidth?: number;
  readonly videoHeight?: number;
  readonly currentSrc?: string;
  readonly error: { code?: number; message?: string } | null;
  playbackRate: number;
  volume: number;
  muted: boolean;
  /** The underlying library instance (hls.js, dash.js, YT.Player) once created. */
  api?: { on?: (event: string, cb: (...args: never[]) => void) => void } | null;
};

const TAGS: Record<Exclude<SourceKind, "vimeo">, string> = {
  file: "video",
  hls: "hls-video",
  dash: "dash-video",
  youtube: "youtube-video",
};

/** Registers the web component for a kind (each is its own chunk). */
function define(kind: SourceKind): Promise<unknown> {
  switch (kind) {
    case "hls":
      return import("hls-video-element");
    case "dash":
      return import("dash-video-element");
    case "youtube":
      return import("youtube-video-element");
    default:
      return Promise.resolve();
  }
}

const AUDIO_ONLY = /\.(mp3|m4a|aac|flac|wav|opus|oga)$/i;
const IFRAME_POLL_MS = 250;
const PLAY_TIMEOUT_MS = 3000;
/** A provider that blocks the viewer (bot checks, network blocks) never reports ready. */
const READY_TIMEOUT_MS = 20_000;

/**
 * One adapter for direct files, HLS, DASH and YouTube. The element does the
 * provider work; this class only maps it onto the PlayerAdapter contract the
 * sync engine uses (errors, autoplay rejection, rate support, smoothing).
 */
export class MediaElementAdapter implements PlayerAdapter {
  readonly kind: SourceKind;
  readonly seekLead: number;
  private readonly events = new Emitter();
  private readonly wrapper: HTMLDivElement;
  private el: MediaLike | null = null;
  private readonly iframe: boolean;
  private failure: string | null = null;
  private isReady = false;
  private seekingUntil = 0;
  private clock = new PositionClock();
  private lastSample: { t: number; at: number } | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private poll: ReturnType<typeof setInterval> | null = null;
  private unbind: (() => void) | null = null;
  private destroyed = false;

  constructor(
    kind: SourceKind,
    container: HTMLElement,
    private readonly opts: PlayerOptions,
    /** Plain <video> even for HLS: Safari's own HLS player instead of hls.js. */
    private readonly native = false,
  ) {
    this.kind = kind;
    this.iframe = kind === "youtube";
    this.seekLead = this.iframe ? 0.3 : 0.1;
    this.wrapper = document.createElement("div");
    this.wrapper.className = "relative aspect-video w-full bg-black";
    if (this.iframe) {
      this.wrapper.dataset.testid = "provider-player";
      this.wrapper.dataset.provider = kind;
    }
    container.appendChild(this.wrapper);
  }

  load(source: MediaSource) {
    this.events.emit("loading");
    void (this.native ? Promise.resolve() : define(this.kind)).then(
      () => {
        if (this.destroyed) return;
        this.attach(source);
      },
      () => this.fail(`Couldn't load the ${this.kind === "youtube" ? "YouTube" : "media"} player.`),
    );
  }

  private attach(source: MediaSource) {
    const el = document.createElement(this.native ? "video" : TAGS[this.kind as keyof typeof TAGS]) as MediaLike;
    if (!this.iframe) el.dataset.testid = "video";
    el.className = "absolute inset-0 block h-full w-full";
    el.controls = this.opts.controls;
    el.playsInline = true;
    el.preload = "auto";
    this.el = el;
    this.wrapper.appendChild(el);
    // Guests watch, they don't drive: keep clicks off the provider's own controls.
    if (this.iframe && !this.opts.controls) this.wrapper.appendChild(clickShield());

    const forward: [string, PlayerEvent][] = [
      ["loadstart", "loading"],
      ["play", "play"],
      ["playing", "playing"],
      ["pause", "pause"],
      // youtube-video guesses seeks from position jumps every 50 ms, which misfires on coarse reports.
      ...(this.iframe ? [] : ([["seeked", "seeked"]] as [string, PlayerEvent][])),
      ["waiting", "waiting"],
      ["stalled", "waiting"],
      ["canplay", "canplay"],
      ["ended", "ended"],
    ];
    const offs = forward.map(([dom, ev]) => this.listen(dom, () => this.events.emit(ev)));
    offs.push(
      this.listen("loadedmetadata", () => this.onMetadata()),
      this.listen("error", () =>
        this.fail(this.iframe ? NOT_DIRECT_MESSAGE : describeMediaError(el.error as MediaError | null)),
      ),
      // Encrypted media needs a DRM license we will never have.
      this.listen("encrypted", () => this.fail(DRM_MESSAGE)),
    );
    if (this.iframe) {
      offs.push(
        this.listen("playing", () => {
          this.seekingUntil = 0;
          this.clock.reset(el.currentTime);
        }),
        this.listen("pause", () => this.clock.reset(el.currentTime)),
      );
      this.later(() => {
        if (!this.isReady) this.fail(NOT_DIRECT_MESSAGE);
      }, READY_TIMEOUT_MS);
      this.poll = setInterval(() => this.sample(), IFRAME_POLL_MS);
    }
    this.unbind = () => offs.forEach((off) => off());
    el.src = source.url;
    this.watchLibraryErrors();
  }

  /** The iframe API has no seek event, so detect jumps in position (e.g. the host using YouTube's own controls). */
  private sample() {
    const el = this.el;
    if (!el || !this.isReady) return;
    const t = el.currentTime;
    const playing = this.ytState() === 1;
    this.clock.set(t, playing);
    const now = performance.now();
    const prev = this.lastSample;
    this.lastSample = { t, at: now };
    if (!prev || now < this.seekingUntil) return;
    const expected = prev.t + (playing ? ((now - prev.at) / 1000) * el.playbackRate : 0);
    if (Math.abs(t - expected) > (playing ? 1 : 0.25)) this.events.emit("seeked");
  }

  /** YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. */
  private ytState(): number | undefined {
    return (this.el?.api as { getPlayerState?: () => number } | null | undefined)?.getPlayerState?.();
  }

  private listen(type: string, fn: () => void) {
    const el = this.el!;
    el.addEventListener(type, fn);
    return () => el.removeEventListener(type, fn);
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }

  private onMetadata() {
    const el = this.el!;
    this.isReady = true;
    // Some codecs (e.g. HEVC in Chrome) load audio but no picture.
    if (
      this.kind === "file" &&
      el.videoWidth === 0 &&
      el.videoHeight === 0 &&
      !AUDIO_ONLY.test(new URL(el.currentSrc || "x:/").pathname)
    ) {
      this.fail(`${INCOMPATIBLE_MESSAGE} No playable video track was found.`);
    }
    this.events.emit("ready");
    if (this.iframe) this.events.emit("canplay");
  }

  /** hls.js and dash.js report fatal errors on their own instance, not on the element. */
  private watchLibraryErrors() {
    if (this.native || (this.kind !== "hls" && this.kind !== "dash")) return;
    const started = performance.now();
    const check = setInterval(() => {
      const api = this.el?.api;
      if (this.destroyed || performance.now() - started > 10_000) return clearInterval(check);
      if (!api?.on) return;
      clearInterval(check);
      if (this.kind === "hls") {
        api.on("hlsError", ((_e: unknown, data: { fatal?: boolean; type?: string }) => {
          if (!data?.fatal) return;
          if (data.type === "keySystemError") this.fail(DRM_MESSAGE);
          else if (data.type === "networkError") this.fail("Network error while loading the stream.");
          else this.fail(INCOMPATIBLE_MESSAGE);
        }) as never);
      } else {
        api.on("error", ((e: { error?: { message?: string } }) => {
          const msg = `${e?.error?.message ?? ""}`.toLowerCase();
          if (/protection|key ?system|license|drm|encrypted/.test(msg)) this.fail(DRM_MESSAGE);
          else if (/download|manifest|network|xhr|fetch/.test(msg)) this.fail("Network error while loading the stream.");
          else this.fail(INCOMPATIBLE_MESSAGE);
        }) as never);
      }
    }, 50);
    this.timers.push(check as unknown as ReturnType<typeof setTimeout>);
  }

  private fail(message: string) {
    if (this.failure) return;
    this.failure = message;
    this.events.emit("error", { message });
  }

  play() {
    const el = this.el;
    if (!el) return Promise.reject(new Error("Player not ready"));
    if (!this.iframe) return el.play();
    if (!el.paused) return Promise.resolve();
    // The YouTube element's play() never rejects: blocked autoplay just leaves it paused.
    return new Promise<void>((resolve, reject) => {
      let done = false;
      void el.play().then(() => {
        done = true;
        resolve();
      });
      this.later(() => {
        if (done) return;
        if (!el.paused) resolve();
        else {
          reject(notAllowed());
        }
      }, PLAY_TIMEOUT_MS);
    });
  }
  pause() {
    void this.el?.pause();
  }
  seek(seconds: number) {
    if (!this.el) return;
    this.el.currentTime = seconds;
    if (this.iframe) {
      this.clock.reset(seconds);
      this.lastSample = { t: seconds, at: performance.now() };
      this.seekingUntil = performance.now() + 1000;
      setTimeout(() => this.events.emit("seeked"), 0);
    }
  }
  currentTime() {
    const el = this.el;
    if (!el) return 0;
    if (!this.iframe) return el.currentTime;
    // Provider iframes report position coarsely; extrapolate between reports, only while frames advance.
    const playing = this.ytState() === 1;
    this.clock.set(el.currentTime, playing);
    return this.clock.get(playing, el.playbackRate);
  }
  duration() {
    const d = this.el?.duration ?? NaN;
    return d > 0 ? d : NaN;
  }
  playing() {
    const el = this.el;
    return !!el && !el.paused && !el.ended;
  }
  ended() {
    return !!this.el?.ended;
  }
  ready() {
    const el = this.el;
    if (!el || this.failure) return false;
    return this.iframe ? this.isReady : el.readyState >= 1;
  }
  canContinue() {
    const el = this.el;
    if (!el) return false;
    // youtube-video has no stalled state of its own; ask the YT player whether it is buffering (3).
    if (this.iframe) return this.isReady && this.ytState() !== 3;
    return el.readyState >= 3;
  }
  seeking() {
    const el = this.el;
    if (!el) return false;
    return this.iframe ? performance.now() < this.seekingUntil : el.seeking;
  }
  error() {
    return this.failure;
  }
  /** What the element knows about the media, for diagnostics. Codecs are only known for hls.js levels. */
  mediaInfo(): MediaInfoSummary | null {
    const el = this.el;
    if (!el || this.iframe || !this.isReady) return null;
    const audio = (el as unknown as { audioTracks?: { length: number } }).audioTracks;
    type Level = { videoCodec?: string; audioCodec?: string; width?: number; height?: number };
    const api = el.api as { levels?: Level[]; currentLevel?: number } | null | undefined;
    const levels = api?.levels;
    const level = levels?.[Math.max(0, api?.currentLevel ?? 0)];
    // The element reports 0×0 until a frame is decoded (hls.js on Managed Media Source does
    // this at loadedmetadata); fall back to the playing level's size, else leave it unknown.
    const width = el.videoWidth || level?.width || 0;
    const height = el.videoHeight || level?.height || 0;
    return {
      ...(width && height ? { width, height } : {}),
      duration: this.duration(),
      ...(audio ? { audioTracks: audio.length } : {}),
      ...(level?.videoCodec ? { videoCodec: level.videoCodec } : {}),
      ...(level?.audioCodec ? { audioCodec: level.audioCodec } : {}),
      ...(levels ? { renditions: levels.length } : {}),
    };
  }
  isBuffered(seconds: number) {
    const b = this.el?.buffered;
    if (this.iframe || !b) return false;
    for (let i = 0; i < b.length; i++) if (seconds >= b.start(i) && seconds <= b.end(i)) return true;
    return false;
  }
  /** YouTube only has coarse rate steps (0.25x), so drift is corrected by seeking there. */
  setRate(rate: number) {
    const el = this.el;
    if (!el) return false;
    if (this.iframe && rate !== 1) return false;
    if (el.playbackRate !== rate) el.playbackRate = rate;
    return true;
  }
  rate() {
    return this.el?.playbackRate ?? 1;
  }
  setVolume(volume: number) {
    if (this.el) this.el.volume = volume;
  }
  setMuted(muted: boolean) {
    if (this.el) this.el.muted = muted;
  }
  on(listener: PlayerListener) {
    return this.events.on(listener);
  }
  destroy() {
    this.destroyed = true;
    this.timers.forEach((t) => clearTimeout(t));
    if (this.poll) clearInterval(this.poll);
    this.unbind?.();
    this.events.clear();
    const el = this.el;
    if (el) {
      el.removeAttribute("src");
      if (el instanceof HTMLMediaElement) el.load();
    }
    this.wrapper.remove();
    this.el = null;
  }
}

/** Guests watch, they don't drive: a transparent layer keeps clicks off the provider's own controls. */
export function clickShield(): HTMLDivElement {
  const shield = document.createElement("div");
  shield.className = "absolute inset-0";
  shield.dataset.testid = "click-shield";
  return shield;
}
