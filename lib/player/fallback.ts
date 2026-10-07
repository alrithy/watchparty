import type { MediaSource, SourceKind } from "@/lib/room/types";
import { INCOMPATIBLE_MESSAGE } from "@/lib/media/source";
import { Emitter, type PlayerAdapter, type PlayerEvent, type PlayerListener } from "@/lib/player/types";
import { MediaElementAdapter, type PlayerOptions } from "@/lib/player/media-element";
import { MOVI_INCOMPATIBLE_MESSAGE, MoviPlayerAdapter } from "@/lib/player/movi";

export type Engine = "native" | "movi";

/** Whether a failure on `engine` is worth one retry on the other engine. */
export function shouldFallBack(engine: Engine, message: string): boolean {
  // <video> said it can't decode this (MEDIA_ERR_SRC_NOT_SUPPORTED / MEDIA_ERR_DECODE / no video track).
  if (engine === "native") return message.startsWith(INCOMPATIBLE_MESSAGE);
  // Movi failed for any reason (no WebCodecs, CORS, no Range): <video> needs neither CORS nor Range.
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

/**
 * A direct media file played by <video> or Movi, switching once if the first
 * can't play it. The switch is local to this device: the room's source and
 * revision don't change, so the host can be on Movi while a guest is on <video>.
 * Position, play/pause, volume, mute and rate carry over; the URL is passed
 * through exactly as pasted.
 */
export class FallbackPlayer implements PlayerAdapter {
  readonly kind: SourceKind = "file";
  private readonly events = new Emitter();
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

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: PlayerOptions,
    private readonly order: [Engine, Engine],
  ) {
    this.use(order[0]);
  }

  /** Which decoder is playing now (for tests and diagnostics). */
  activeEngine(): Engine {
    return this.engine;
  }

  get seekLead() {
    return this.inner.seekLead;
  }

  private use(engine: Engine) {
    this.engine = engine;
    this.inner =
      engine === "movi" ? new MoviPlayerAdapter(this.container, this.opts) : new MediaElementAdapter("file", this.container, this.opts);
    this.inner.setRate(1);
    this.off = this.inner.on((e, detail) => this.onInner(e, detail));
  }

  private onInner(e: PlayerEvent, detail?: { message?: string }) {
    if (this.switching) return;
    if (e === "error") {
      const message = detail?.message ?? "Playback failed.";
      if (!this.firstFailure && shouldFallBack(this.engine, message)) {
        this.firstFailure = { engine: this.engine, message };
        this.switching = true;
        // Switch after the failing adapter has finished dispatching this event.
        queueMicrotask(() => this.switchEngine());
        return;
      }
      const final = this.firstFailure ? finalMessage(this.firstFailure, message) : message;
      this.events.emit("error", { message: final });
      return;
    }
    if (e === "ready") {
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

  private switchEngine() {
    if (this.destroyed || !this.source) return;
    const old = this.inner;
    const at = old.ready() ? old.currentTime() : 0;
    this.resume = { at: Number.isFinite(at) ? at : 0, playing: this.wantPlay };
    this.off?.();
    old.destroy();
    this.switching = false;
    this.use(this.order[1]);
    this.inner.load(this.source);
  }

  load(source: MediaSource) {
    this.source = source;
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
