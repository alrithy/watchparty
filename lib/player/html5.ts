import type { MediaSource, SourceKind } from "@/lib/room/types";
import { INCOMPATIBLE_MESSAGE, NOT_DIRECT_MESSAGE, describeMediaError } from "@/lib/media/source";
import { Emitter, type PlayerAdapter, type PlayerEvent, type PlayerListener } from "@/lib/player/types";

export type PlayerOptions = { controls: boolean };

const AUDIO_ONLY = /\.(mp3|m4a|aac|flac|wav|opus|oga)$/i;

/** Native <video>. Direct files (MP4, WebM, ...) play as-is; HLS/DASH subclasses attach a library. */
export class Html5PlayerAdapter implements PlayerAdapter {
  readonly kind: SourceKind = "file";
  readonly seekLead = 0.1;
  protected readonly video: HTMLVideoElement;
  protected readonly events = new Emitter();
  protected detach: (() => void) | null = null;
  private failure: string | null = null;
  private readonly unbind: () => void;

  constructor(container: HTMLElement, { controls }: PlayerOptions) {
    const v = document.createElement("video");
    v.dataset.testid = "video";
    v.className = "aspect-video w-full bg-black";
    v.controls = controls;
    v.playsInline = true;
    v.preload = "auto";
    container.appendChild(v);
    this.video = v;

    const forward: [keyof HTMLMediaElementEventMap, PlayerEvent][] = [
      ["loadstart", "loading"],
      ["play", "play"],
      ["playing", "playing"],
      ["pause", "pause"],
      ["seeked", "seeked"],
      ["waiting", "waiting"],
      ["stalled", "waiting"],
      ["canplay", "canplay"],
      ["ended", "ended"],
    ];
    const handlers = forward.map(([dom, ev]) => {
      const h = () => this.events.emit(ev);
      v.addEventListener(dom, h);
      return () => v.removeEventListener(dom, h);
    });
    const onMeta = () => {
      // Some codecs (e.g. HEVC in Chrome) load audio but no picture.
      if (v.videoWidth === 0 && v.videoHeight === 0 && !AUDIO_ONLY.test(new URL(v.currentSrc || "x:/").pathname)) {
        this.fail(`${INCOMPATIBLE_MESSAGE} No playable video track was found.`);
      }
      this.events.emit("ready");
    };
    const onError = () => this.fail(describeMediaError(v.error));
    // Encrypted media needs a DRM license we will never have.
    const onEncrypted = () => this.fail(NOT_DIRECT_MESSAGE);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("error", onError);
    v.addEventListener("encrypted", onEncrypted);
    this.unbind = () => {
      for (const off of handlers) off();
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("error", onError);
      v.removeEventListener("encrypted", onEncrypted);
    };
  }

  protected fail(message: string) {
    if (this.failure) return;
    this.failure = message;
    this.events.emit("error", { message });
  }

  /** Points the element at the source. Subclasses use a streaming library instead. */
  protected attach(source: MediaSource): void {
    this.video.src = source.url;
    this.video.load();
  }

  load(source: MediaSource) {
    this.detach?.();
    this.detach = null;
    this.failure = null;
    this.attach(source);
  }

  play() {
    return this.video.play();
  }
  pause() {
    this.video.pause();
  }
  seek(seconds: number) {
    this.video.currentTime = seconds;
  }
  currentTime() {
    return this.video.currentTime;
  }
  duration() {
    return this.video.duration;
  }
  playing() {
    return !this.video.paused && !this.video.ended;
  }
  ended() {
    return this.video.ended;
  }
  ready() {
    return this.video.readyState >= HTMLMediaElement.HAVE_METADATA && !this.video.error;
  }
  canContinue() {
    return this.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  }
  seeking() {
    return this.video.seeking;
  }
  error() {
    return this.failure;
  }
  setRate(rate: number) {
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
    return true;
  }
  rate() {
    return this.video.playbackRate;
  }
  setVolume(volume: number) {
    this.video.volume = volume;
  }
  setMuted(muted: boolean) {
    this.video.muted = muted;
  }
  on(listener: PlayerListener) {
    return this.events.on(listener);
  }
  destroy() {
    this.detach?.();
    this.detach = null;
    this.unbind();
    this.events.clear();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.remove();
  }
}

/** HLS: native where the browser has it (Safari, iOS), hls.js elsewhere. */
export class HlsPlayerAdapter extends Html5PlayerAdapter {
  override readonly kind: SourceKind = "hls";

  protected override attach(source: MediaSource) {
    if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
      super.attach(source);
      return;
    }
    let cancelled = false;
    let destroy: (() => void) | undefined;
    this.detach = () => {
      cancelled = true;
      destroy?.();
    };
    this.events.emit("loading");
    void import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        this.fail(INCOMPATIBLE_MESSAGE);
        return;
      }
      const hls = new Hls();
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.KEY_SYSTEM_ERROR) this.fail(NOT_DIRECT_MESSAGE);
        else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) this.fail("Network error while loading the stream.");
        else this.fail(INCOMPATIBLE_MESSAGE);
      });
      hls.loadSource(source.url);
      hls.attachMedia(this.video);
      destroy = () => hls.destroy();
    });
  }
}

/** MPEG-DASH through dash.js, loaded only when a .mpd source is played. */
export class DashPlayerAdapter extends Html5PlayerAdapter {
  override readonly kind: SourceKind = "dash";

  protected override attach(source: MediaSource) {
    let cancelled = false;
    let destroy: (() => void) | undefined;
    this.detach = () => {
      cancelled = true;
      destroy?.();
    };
    this.events.emit("loading");
    void import("dashjs").then((dashjs) => {
      if (cancelled) return;
      if (!dashjs.supportsMediaSource()) {
        this.fail(INCOMPATIBLE_MESSAGE);
        return;
      }
      const player = dashjs.MediaPlayer().create();
      player.on("error", (e: { error?: { code?: number; message?: string } }) => {
        const msg = `${e.error?.message ?? ""}`.toLowerCase();
        if (/protection|key ?system|license|drm|encrypted/.test(msg)) this.fail(NOT_DIRECT_MESSAGE);
        else if (/download|manifest|network|xhr|fetch/.test(msg)) this.fail("Network error while loading the stream.");
        else this.fail(INCOMPATIBLE_MESSAGE);
      });
      player.initialize(this.video, source.url, false);
      destroy = () => player.reset();
    });
  }
}
