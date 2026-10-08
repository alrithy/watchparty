import type { MoviPlayer, PlayerState } from "movi-player/player";
import type { MediaSource, SourceKind } from "@/lib/room/types";
import { INCOMPATIBLE_MESSAGE } from "@/lib/media/source";
import { Emitter, notAllowed, type MediaInfoSummary, type PlayerAdapter, type PlayerListener } from "@/lib/player/types";
import type { PlayerOptions } from "@/lib/player/media-element";

/**
 * Bytes Movi may hold for one video: its LRU cache and its HTTP read-ahead
 * window share this cap, so a 80 GB remux streams through ~128 MB of memory.
 */
export const MOVI_CACHE_MB = 128;

export const RANGE_BLOCKED_MESSAGE = "This link blocks browser byte-range access, so this format can't be streamed here.";
export const MOVI_INCOMPATIBLE_MESSAGE = `${INCOMPATIBLE_MESSAGE} Neither the browser nor the fallback decoder could play it.`;

export type MoviFailure = "range" | "missing" | "denied" | "codec";

/**
 * Sorts Movi's error text (from its HttpSource and demuxer) into what the viewer can act on.
 * CORS and missing Range support look alike from the page, and both need a
 * different link (or, later, a browser helper), so they share one message.
 */
export function classifyMoviError(message: string): MoviFailure {
  const m = message.toLowerCase();
  if (/cors|failed to fetch|range request|byte-range|linear/.test(m)) return "range";
  if (/not found|\b404\b|\b410\b/.test(m)) return "missing";
  if (/access denied|authentication|\b401\b|\b403\b/.test(m)) return "denied";
  return "codec";
}

export function moviErrorMessage(kind: MoviFailure): string {
  switch (kind) {
    case "range":
      return RANGE_BLOCKED_MESSAGE;
    case "missing":
      return "The video link wasn't found. It may have expired.";
    case "denied":
      return "The video link refused access. It may have expired.";
    default:
      return MOVI_INCOMPATIBLE_MESSAGE;
  }
}

/** Movi (FFmpeg WASM demux + WebCodecs) is ~11 MB, so it's fetched only when a video needs it. */
let moviModule: Promise<typeof import("movi-player/player")> | null = null;
function loadMovi() {
  moviModule ??= import("movi-player/player").catch((e: unknown) => {
    moviModule = null;
    throw e;
  });
  return moviModule;
}

/** Movi's play() never rejects on blocked autoplay (audio just stays silent), so ask the browser first. */
async function audioAllowed(): Promise<boolean> {
  const nav = navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
  if (nav.userActivation?.hasBeenActive) return true;
  if (typeof AudioContext === "undefined") return true;
  const ctx = new AudioContext();
  try {
    return ctx.state === "running";
  } finally {
    void ctx.close().catch(() => {});
  }
}

const UI_TICK_MS = 250;

/**
 * Direct media the browser can't decode itself (MKV, HEVC, AC-3/DTS audio...),
 * through movi-player's headless MoviPlayer: HTTP Range reads, FFmpeg WASM
 * demux, WebCodecs decode, canvas output. Only maps it onto PlayerAdapter;
 * subtitles stay with our own overlay and Movi's UI is not used.
 */
export class MoviPlayerAdapter implements PlayerAdapter {
  readonly kind: SourceKind = "file";
  /** Seeks re-open the demuxer at a keyframe and decode forward, so they land later than <video>'s. */
  readonly seekLead = 0.3;
  private readonly events = new Emitter();
  private readonly wrapper: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private player: MoviPlayer | null = null;
  private isReady = false;
  private wantPlay = false;
  private pendingSeek: number | null = null;
  private seekTarget: number | null = null;
  private failure: string | null = null;
  private currentRate = 1;
  private volume = 1;
  private muted = false;
  private offs: (() => void)[] = [];
  private resize: ResizeObserver | null = null;
  private uiTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(
    container: HTMLElement,
    private readonly opts: PlayerOptions,
  ) {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "relative aspect-video w-full bg-black";
    this.wrapper.dataset.testid = "provider-player";
    this.wrapper.dataset.provider = "movi";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "absolute inset-0 block h-full w-full";
    this.canvas.dataset.testid = "movi-canvas";
    this.wrapper.appendChild(this.canvas);
    container.appendChild(this.wrapper);
  }

  load(source: MediaSource) {
    this.events.emit("loading");
    void this.open(source.url);
  }

  private async open(url: string) {
    let mod: typeof import("movi-player/player");
    try {
      mod = await loadMovi();
    } catch {
      return this.fail("Couldn't load the video decoder.");
    }
    if (this.destroyed) return;
    // Its logs can include the media URL, and signed URLs must stay out of consoles and logs.
    mod.Logger.setLevel(mod.LogLevel.SILENT);
    const player = new mod.MoviPlayer({
      // Passed through untouched: signed query strings must reach the server as pasted.
      source: { type: "url", url },
      renderer: "canvas",
      canvas: this.canvas,
      cache: { type: "lru", maxSizeMB: MOVI_CACHE_MB },
    });
    this.player = player;
    this.sizeCanvas();
    this.offs.push(
      player.on("stateChange", (s) => this.onState(s)),
      player.on("seeked", () => {
        this.seekTarget = null;
        this.events.emit("seeked");
      }),
      player.on("ended", () => {
        this.wantPlay = false;
        this.events.emit("pause");
        this.events.emit("ended");
      }),
      player.on("error", (e) => this.fail(moviErrorMessage(classifyMoviError(e?.message ?? String(e))))),
      // No Range support and too big to hold: forward-only playback can't follow the room.
      player.on("linearmode", () => this.fail(RANGE_BLOCKED_MESSAGE)),
    );
    try {
      await player.load();
    } catch (e) {
      return this.fail(moviErrorMessage(classifyMoviError(e instanceof Error ? e.message : String(e))));
    }
    if (this.destroyed || this.failure) return;
    player.setVolume(this.volume);
    player.setMuted(this.muted);
    if (this.currentRate !== 1) player.setPlaybackRate(this.currentRate);
    this.isReady = true;
    if (this.opts.controls) this.wrapper.appendChild(this.controls());
    this.events.emit("ready");
    this.events.emit("canplay");
    if (this.pendingSeek !== null) {
      const t = this.pendingSeek;
      this.pendingSeek = null;
      this.seek(t);
    }
    if (this.wantPlay) void player.play().catch(() => {});
  }

  private onState(s: PlayerState) {
    switch (s) {
      case "playing":
        this.events.emit("playing");
        this.events.emit("canplay");
        break;
      case "buffering":
        this.events.emit("waiting");
        break;
    }
  }

  private sizeCanvas() {
    const fit = () => {
      const r = this.wrapper.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      this.player?.resizeCanvas(w, h);
    };
    fit();
    this.resize = new ResizeObserver(fit);
    this.resize.observe(this.wrapper);
  }

  /** The host's transport controls: <video> brings its own, a canvas doesn't. */
  private controls(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className =
      "absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-6 text-xs text-white";
    bar.dataset.testid = "movi-controls";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "w-14 rounded border border-white/40 px-2 py-0.5";
    toggle.dataset.testid = "movi-play";
    const seek = document.createElement("input");
    seek.type = "range";
    seek.min = "0";
    seek.step = "0.1";
    seek.className = "flex-1";
    seek.setAttribute("aria-label", "Seek");
    seek.dataset.testid = "movi-seek";
    const time = document.createElement("span");
    time.className = "tabular-nums";
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "rounded border border-white/40 px-2 py-0.5";
    bar.append(toggle, seek, time, mute);

    let dragging = false;
    toggle.onclick = () => (this.playing() ? this.pause() : void this.play().catch(() => {}));
    seek.oninput = () => (dragging = true);
    seek.onchange = () => {
      dragging = false;
      this.seek(Number(seek.value));
    };
    mute.onclick = () => this.setMuted(!this.muted);
    const render = () => {
      const d = this.duration();
      const t = this.currentTime();
      toggle.textContent = this.playing() ? "Pause" : "Play";
      mute.textContent = this.muted ? "Unmute" : "Mute";
      if (Number.isFinite(d)) seek.max = String(d);
      if (!dragging) seek.value = String(t);
      time.textContent = `${clock(t)} / ${Number.isFinite(d) ? clock(d) : "--:--"}`;
    };
    render();
    this.uiTimer = setInterval(render, UI_TICK_MS);
    return bar;
  }

  private fail(message: string) {
    if (this.failure || this.destroyed) return;
    this.failure = message;
    this.events.emit("error", { message });
  }

  async play() {
    if (!this.muted && !(await audioAllowed())) throw notAllowed();
    this.wantPlay = true;
    this.events.emit("play");
    if (this.player && this.isReady) await this.player.play();
  }
  pause() {
    this.wantPlay = false;
    this.player?.pause();
    this.events.emit("pause");
  }
  seek(seconds: number) {
    const target = Math.max(0, seconds);
    if (!this.player || !this.isReady) {
      this.pendingSeek = target;
      return;
    }
    this.seekTarget = target;
    void this.player.seek(target).catch(() => {
      this.seekTarget = null;
    });
  }
  currentTime() {
    // Like <video>.currentTime, report the target while a seek is in flight.
    if (this.seekTarget !== null) return this.seekTarget;
    if (!this.isReady) return this.pendingSeek ?? 0;
    return this.player?.getCurrentTime() ?? 0;
  }
  duration() {
    const d = this.isReady ? (this.player?.getDuration() ?? NaN) : NaN;
    return d > 0 ? d : NaN;
  }
  playing() {
    return this.wantPlay && !this.ended();
  }
  ended() {
    return this.player?.getState() === "ended";
  }
  ready() {
    return this.isReady && !this.failure;
  }
  canContinue() {
    if (!this.ready() || this.seekTarget !== null) return false;
    const s = this.player?.getState();
    return s === "playing" || s === "paused" || s === "ready" || s === "ended";
  }
  seeking() {
    return this.seekTarget !== null || this.player?.getState() === "seeking";
  }
  isBuffered(seconds: number) {
    const p = this.player;
    if (!p || !this.isReady) return false;
    return seconds >= p.getBufferedRangeStart() && seconds <= p.getBufferedTime();
  }
  error() {
    return this.failure;
  }
  mediaInfo(): MediaInfoSummary | null {
    const info = this.isReady ? this.player?.getMediaInfo() : null;
    if (!info) return null;
    const video = info.tracks.find((t) => t.type === "video");
    const audio = info.tracks.filter((t) => t.type === "audio");
    return {
      ...(video?.width && video?.height ? { width: video.width, height: video.height } : {}),
      duration: this.duration(),
      container: info.formatName,
      ...(video ? { videoCodec: video.codecString || video.codec } : {}),
      ...(audio[0] ? { audioCodec: audio[0].codecString || audio[0].codec } : {}),
      audioTracks: audio.length,
    };
  }
  setRate(rate: number) {
    if (rate === this.currentRate) return true;
    this.currentRate = rate;
    if (this.player && this.isReady) this.player.setPlaybackRate(rate);
    return true;
  }
  rate() {
    return this.currentRate;
  }
  setVolume(volume: number) {
    this.volume = volume;
    if (this.isReady) this.player?.setVolume(volume);
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.isReady) this.player?.setMuted(muted);
  }
  on(listener: PlayerListener) {
    return this.events.on(listener);
  }
  destroy() {
    this.destroyed = true;
    if (this.uiTimer) clearInterval(this.uiTimer);
    this.resize?.disconnect();
    this.offs.forEach((off) => off());
    this.events.clear();
    this.player?.destroy();
    this.player = null;
    this.wrapper.remove();
  }
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
