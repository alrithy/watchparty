import type { MediaSource, SourceKind } from "@/lib/room/types";
import { INCOMPATIBLE_MESSAGE } from "@/lib/media/source";
import { Emitter, type PlayerAdapter, type PlayerEvent, type PlayerListener } from "@/lib/player/types";
import { MediaElementAdapter, type PlayerOptions } from "@/lib/player/media-element";
import { MOVI_INCOMPATIBLE_MESSAGE, MoviPlayerAdapter, RANGE_BLOCKED_MESSAGE } from "@/lib/player/movi";
import { refineStreamUrl, type Refinement } from "@/lib/media/refine";
import { classifyFailure, isTerminal } from "@/lib/media/errors";
import type { DiagnosticsSession } from "@/lib/media/diagnostics";
import { safeHost } from "@/lib/media/diagnostics";
import type { Engine as AnyEngine } from "@/lib/media/route";

/** Engines this player can switch between (the provider iframes have their own adapters). */
export type Engine = Exclude<AnyEngine, "youtube" | "vimeo">;

/** Whether a failure on `engine` is worth one retry on the next engine. */
export function shouldFallBack(engine: Engine, message: string): boolean {
  if (isTerminal(classifyFailure(engine, message))) return false;
  // <video> said it can't decode this (MEDIA_ERR_SRC_NOT_SUPPORTED / MEDIA_ERR_DECODE / no video track).
  // A network error from <video> would fail the same way anywhere else.
  if (engine === "native") return message.startsWith(INCOMPATIBLE_MESSAGE);
  // Movi failed for any reason (no WebCodecs, CORS, no Range): <video> needs neither CORS nor Range.
  // hls.js failed: the browser's own HLS player (where there is one) needs no CORS either.
  return true;
}

/** What to tell the viewer once both engines have failed. */
export function finalMessage(first: { engine: Engine; message: string }, second: string): string {
  // Movi couldn't read the bytes (blocked, missing, refused) and <video> only says it can't decode
  // them: Movi's reason is the one the viewer can act on.
  if (first.engine === "movi" && first.message !== MOVI_INCOMPATIBLE_MESSAGE && second.startsWith(INCOMPATIBLE_MESSAGE)) {
    return first.message;
  }
  return second;
}

export type FallbackOptions = {
  /** What the room is playing: "file" (native/Movi) or "hls"/"dash" (stream engines). */
  kind?: SourceKind;
  /** Where attempts are recorded for the diagnostics panel. */
  session?: DiagnosticsSession;
};

/**
 * A source played by the engines its plan lists (<video>, Movi, hls.js,
 * dash.js), switching once if the first can't play it. The switch is local to
 * this device: the room's source and revision don't change, so the host can be
 * on Movi while a guest is on <video>, or Safari's own HLS while Chrome uses
 * hls.js. Position, play/pause, volume, mute and rate carry over; the URL is
 * passed through exactly as pasted.
 *
 * When Movi is refused byte-range access, the redirect chain is resolved once on
 * the server (headers only, never bytes) and Movi is restarted once on the final
 * URL if this page can read it. That swap is local too and never loops.
 */
export class FallbackPlayer implements PlayerAdapter {
  readonly kind: SourceKind;
  private readonly events = new Emitter();
  private readonly session: DiagnosticsSession | null;
  /** Index of the engine in use within `order`. */
  private step = 0;
  private inner!: PlayerAdapter;
  private engine!: Engine;
  private off: (() => void) | null = null;
  private source: MediaSource | null = null;
  private firstFailure: { engine: Engine; message: string } | null = null;
  private wantPlay = false;
  private volume: number | null = null;
  private muted: boolean | null = null;
  private resume: { at: number; playing: boolean } | null = null;
  /** Set between a failure and the switch, so the failing adapter's last events are dropped. */
  private switching = false;
  private destroyed = false;
  /** The redirect chain has been resolved once for this source (never twice). */
  private refined = false;
  /** Why the last attempt failed, when it has an internal name (e.g. FINAL_CDN_CORS_BLOCKED). */
  private reason: string | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: PlayerOptions,
    private readonly order: Engine[],
    private readonly refine: (url: string) => Promise<Refinement | null> = refineStreamUrl,
    options: FallbackOptions = {},
  ) {
    this.kind = options.kind ?? "file";
    this.session = options.session ?? null;
    this.use(order[0]);
  }

  /** Which decoder is playing now (for tests and diagnostics). */
  activeEngine(): Engine {
    return this.engine;
  }

  /** Internal failure reason, if any (for tests and diagnostics). */
  failureReason(): string | null {
    return this.reason;
  }

  get seekLead() {
    return this.inner.seekLead;
  }

  private make(engine: Engine): PlayerAdapter {
    switch (engine) {
      case "movi":
        return new MoviPlayerAdapter(this.container, this.opts);
      case "hlsjs":
        return new MediaElementAdapter("hls", this.container, this.opts);
      case "dashjs":
        return new MediaElementAdapter("dash", this.container, this.opts);
      default:
        return new MediaElementAdapter(this.kind === "hls" ? "hls" : "file", this.container, this.opts, true);
    }
  }

  private use(engine: Engine) {
    this.engine = engine;
    this.inner = this.make(engine);
    this.session?.attempt(engine);
    this.inner.setRate(1);
    this.off = this.inner.on((e, detail) => this.onInner(e, detail));
  }

  private onInner(e: PlayerEvent, detail?: { message?: string }) {
    if (this.switching) return;
    if (e === "error") {
      const message = detail?.message ?? "Playback failed.";
      if (this.engine === "movi" && message === RANGE_BLOCKED_MESSAGE && !this.refined && this.source) {
        this.refined = true;
        this.session?.failed("RANGE_UNSUPPORTED", message);
        this.switching = true;
        void this.refineAndRetry(this.source, message);
        return;
      }
      const next = this.order[this.step + 1];
      if (!this.firstFailure && next && shouldFallBack(this.engine, message)) {
        this.firstFailure = { engine: this.engine, message };
        this.session?.failed(classifyFailure(this.engine, message, this.reason), message);
        this.switching = true;
        this.step++;
        // Switch after the failing adapter has finished dispatching this event.
        queueMicrotask(() => this.source && this.switchTo(next, this.source));
        return;
      }
      const final = this.firstFailure ? finalMessage(this.firstFailure, message) : message;
      const blamed = final === message ? this.engine : (this.firstFailure?.engine ?? this.engine);
      this.session?.failed(classifyFailure(blamed, final, this.reason), final);
      this.events.emit("error", { message: final });
      return;
    }
    if (e === "playing") this.session?.playing();
    if (e === "ready") {
      this.session?.ready(this.inner.mediaInfo?.());
      if (this.volume !== null) this.inner.setVolume(this.volume);
      if (this.muted !== null) this.inner.setMuted(this.muted);
      const r = this.resume;
      this.resume = null;
      this.events.emit(e, detail);
      if (r) {
        if (r.at > 0) this.inner.seek(r.at);
        if (r.playing) void this.inner.play().catch(() => {});
      }
      return;
    }
    if (e === "play") this.wantPlay = true;
    if (e === "pause") this.wantPlay = false;
    this.events.emit(e, detail);
  }

  /** Replaces the current adapter, carrying position and play state over. `source` is local to this device. */
  private switchTo(engine: Engine, source: MediaSource) {
    if (this.destroyed) return;
    const old = this.inner;
    const at = this.currentTime();
    this.resume = { at: Number.isFinite(at) ? at : 0, playing: this.wantPlay };
    this.off?.();
    old.destroy();
    this.switching = false;
    this.use(engine);
    this.inner.load(source);
  }

  /**
   * Movi couldn't read the link with Range requests from this page. Usually a
   * redirect hop (e.g. a debrid unrestrict link) lacks CORS while the CDN it
   * lands on allows it: ask the server where the chain ends, check that this
   * page can read the end, and restart Movi there. One pass, one retry.
   */
  private async refineAndRetry(source: MediaSource, message: string) {
    let r: Refinement | null = null;
    try {
      r = await this.refine(source.url);
    } catch {
      r = null;
    }
    if (this.destroyed || source !== this.source) return;
    if (r && "url" in r) {
      this.session?.resolved(safeHost(r.url), true);
      this.switchTo("movi", { ...source, url: r.url });
      return;
    }
    this.reason = r && "reason" in r ? (r.reason ?? null) : null;
    this.switching = false;
    // Carry on as for any Movi failure: <video> gets the original link if it hasn't tried yet.
    this.onInner("error", { message: r?.message ?? message });
  }

  load(source: MediaSource) {
    this.source = source;
    this.refined = false;
    this.reason = null;
    this.inner.load(source);
  }
  play() {
    this.wantPlay = true;
    return this.inner.play();
  }
  pause() {
    this.wantPlay = false;
    this.inner.pause();
  }
  seek(seconds: number) {
    if (this.resume) this.resume.at = seconds;
    this.inner.seek(seconds);
  }
  currentTime() {
    return this.resume && !this.inner.ready() ? this.resume.at : this.inner.currentTime();
  }
  duration() {
    return this.inner.duration();
  }
  playing() {
    return this.resume && !this.inner.ready() ? this.resume.playing : this.inner.playing();
  }
  ended() {
    return this.inner.ended();
  }
  ready() {
    return this.inner.ready();
  }
  canContinue() {
    return this.inner.canContinue();
  }
  seeking() {
    return this.inner.seeking();
  }
  isBuffered(seconds: number) {
    return this.inner.isBuffered?.(seconds) ?? false;
  }
  error() {
    if (this.switching) return null;
    const e = this.inner.error();
    return e && this.firstFailure ? finalMessage(this.firstFailure, e) : e;
  }
  setRate(rate: number) {
    return this.inner.setRate(rate);
  }
  rate() {
    return this.inner.rate();
  }
  setVolume(volume: number) {
    this.volume = volume;
    this.inner.setVolume(volume);
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    this.inner.setMuted(muted);
  }
  on(listener: PlayerListener) {
    return this.events.on(listener);
  }
  destroy() {
    this.destroyed = true;
    this.off?.();
    this.events.clear();
    this.inner.destroy();
  }
}
