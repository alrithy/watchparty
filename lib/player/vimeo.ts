import type { MediaSource, SourceKind } from "@/lib/room/types";
import { NOT_DIRECT_MESSAGE } from "@/lib/media/source";
import { Emitter, notAllowed, type PlayerAdapter, type PlayerListener } from "@/lib/player/types";
import { PositionClock, loadScript } from "@/lib/player/script";
import { clickShield, type PlayerOptions } from "@/lib/player/media-element";

/** The subset of the official Vimeo Player SDK we use. */
type VimeoPlayer = {
  on(event: string, cb: (data?: { seconds?: number; duration?: number; name?: string; message?: string }) => void): void;
  ready(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  setCurrentTime(seconds: number): Promise<number>;
  getCurrentTime(): Promise<number>;
  getDuration(): Promise<number>;
  setPlaybackRate(rate: number): Promise<number>;
  setVolume(volume: number): Promise<number>;
  setMuted(muted: boolean): Promise<boolean>;
  destroy(): Promise<void>;
};
declare global {
  interface Window {
    Vimeo?: { Player: new (el: HTMLElement, opts: Record<string, unknown>) => VimeoPlayer };
  }
}

const POLL_MS = 250;
/** A provider that blocks the viewer (bot checks, network blocks) never reports ready. */
const READY_TIMEOUT_MS = 20_000;

/** Vimeo through the official Player SDK (player.vimeo.com/api/player.js). */
export class VimeoPlayerAdapter implements PlayerAdapter {
  readonly kind: SourceKind = "vimeo";
  readonly seekLead = 0.3;
  private readonly events = new Emitter();
  private readonly wrapper: HTMLDivElement;
  private readonly target: HTMLDivElement;
  private player: VimeoPlayer | null = null;
  private isReady = false;
  private isPlaying = false;
  private isEnded = false;
  private buffering = false;
  private isSeeking = false;
  private dur = NaN;
  private currentRate = 1;
  private rateSupported: boolean | null = null;
  private failure: string | null = null;
  private clock = new PositionClock();
  private poll: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(container: HTMLElement, private readonly opts: PlayerOptions) {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "relative aspect-video w-full bg-black";
    this.wrapper.dataset.testid = "provider-player";
    this.wrapper.dataset.provider = "vimeo";
    this.target = document.createElement("div");
    this.target.className = "absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full";
    this.wrapper.appendChild(this.target);
    if (!opts.controls) this.wrapper.appendChild(clickShield());
    container.appendChild(this.wrapper);
  }

  load(source: MediaSource) {
    this.events.emit("loading");
    void loadScript("https://player.vimeo.com/api/player.js", () => Boolean(window.Vimeo?.Player)).then(
      () => {
        if (this.destroyed || !window.Vimeo) return;
        const p = new window.Vimeo.Player(this.target, {
          url: source.hash ? `https://vimeo.com/${source.videoId}/${source.hash}` : `https://vimeo.com/${source.videoId}`,
          controls: this.opts.controls,
          keyboard: this.opts.controls,
          playsinline: true,
          dnt: true,
          responsive: false,
          width: 640,
        });
        this.player = p;
        p.on("loaded", () => {
          if (this.readyTimer) clearTimeout(this.readyTimer);
          this.isReady = true;
          void p.getDuration().then((d) => (this.dur = d > 0 ? d : NaN));
          this.events.emit("ready");
          this.events.emit("canplay");
        });
        p.on("play", (d) => {
          if (d?.seconds !== undefined) this.clock.reset(d.seconds);
          this.isPlaying = true;
          this.isEnded = false;
          this.events.emit("play");
        });
        p.on("playing", (d) => {
          if (d?.seconds !== undefined) this.clock.reset(d.seconds);
          this.isPlaying = true;
          this.buffering = false;
          this.events.emit("playing");
          this.events.emit("canplay");
        });
        p.on("pause", (d) => {
          this.isPlaying = false;
          if (d?.seconds !== undefined) this.clock.reset(d.seconds);
          this.events.emit("pause");
        });
        p.on("seeked", (d) => {
          this.isSeeking = false;
          if (d?.seconds !== undefined) this.clock.reset(d.seconds);
          this.events.emit("seeked");
        });
        p.on("timeupdate", (d) => {
          if (d?.seconds !== undefined) this.clock.set(d.seconds, this.advancing());
          if (d?.duration) this.dur = d.duration;
        });
        p.on("bufferstart", () => {
          this.buffering = true;
          this.events.emit("waiting");
        });
        p.on("bufferend", () => {
          this.buffering = false;
          this.events.emit("canplay");
        });
        p.on("ended", () => {
          this.isPlaying = false;
          this.isEnded = true;
          this.events.emit("pause");
          this.events.emit("ended");
        });
        p.on("playbackratechange", (d) => {
          if (d && "playbackRate" in d) this.currentRate = Number((d as { playbackRate: number }).playbackRate) || 1;
        });
        // Private, password-protected, deleted or embed-restricted videos.
        p.on("error", () => this.fail(NOT_DIRECT_MESSAGE));
        p.ready().catch(() => this.fail(NOT_DIRECT_MESSAGE));
        this.readyTimer = setTimeout(() => {
          if (!this.isReady) this.fail(NOT_DIRECT_MESSAGE);
        }, READY_TIMEOUT_MS);
        this.poll = setInterval(() => {
          if (this.isReady) void p.getCurrentTime().then((t) => this.clock.set(t, this.advancing())).catch(() => {});
        }, POLL_MS);
      },
      () => this.fail("Couldn't load the Vimeo player."),
    );
  }

  private fail(message: string) {
    if (this.failure) return;
    this.failure = message;
    this.events.emit("error", { message });
  }

  async play() {
    if (!this.player) throw new Error("Player not ready");
    try {
      await this.player.play();
    } catch (e) {
      if ((e as { name?: string })?.name === "NotAllowedError") throw notAllowed();
      if (/Password|Privacy/.test((e as { name?: string })?.name ?? "")) this.fail(NOT_DIRECT_MESSAGE);
      throw e;
    }
  }
  pause() {
    this.isPlaying = false;
    void this.player?.pause().catch(() => {});
  }
  seek(seconds: number) {
    if (!this.player) return;
    this.isSeeking = true;
    this.clock.reset(seconds);
    void this.player.setCurrentTime(seconds).catch(() => (this.isSeeking = false));
  }
  private advancing() {
    return this.isPlaying && !this.buffering && !this.isSeeking;
  }
  currentTime() {
    return this.clock.get(this.advancing(), this.currentRate);
  }
  duration() {
    return this.dur;
  }
  playing() {
    return this.isPlaying;
  }
  ended() {
    return this.isEnded;
  }
  ready() {
    return this.isReady && !this.failure;
  }
  canContinue() {
    return this.isReady && !this.buffering;
  }
  seeking() {
    return this.isSeeking;
  }
  error() {
    return this.failure;
  }
  /** Vimeo only allows rate changes on some account tiers; fall back to seeking once refused. */
  setRate(rate: number) {
    if (!this.player) return false;
    if (rate === this.currentRate) return true;
    if (this.rateSupported === false) return rate === 1;
    this.currentRate = rate;
    this.player.setPlaybackRate(rate).then(
      () => (this.rateSupported = true),
      () => {
        this.rateSupported = false;
        this.currentRate = 1;
      },
    );
    return true;
  }
  rate() {
    return this.currentRate;
  }
  setVolume(volume: number) {
    void this.player?.setVolume(volume).catch(() => {});
  }
  setMuted(muted: boolean) {
    void this.player?.setMuted(muted).catch(() => {});
  }
  on(listener: PlayerListener) {
    return this.events.on(listener);
  }
  destroy() {
    this.destroyed = true;
    if (this.poll) clearInterval(this.poll);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.events.clear();
    void this.player?.destroy().catch(() => {});
    this.player = null;
    this.wrapper.remove();
  }
}
