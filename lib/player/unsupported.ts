import type { SourceKind } from "@/lib/room/types";
import { Emitter, type PlayerAdapter, type PlayerListener } from "@/lib/player/types";

/**
 * Stands in when no engine on this device can play the source (e.g. DASH
 * without Media Source). It fails on load with a specific reason instead of
 * downloading a player that can't work here; the room carries on for others.
 */
export class UnsupportedPlayer implements PlayerAdapter {
  readonly seekLead = 0;
  private readonly events = new Emitter();
  private readonly wrapper: HTMLDivElement;

  constructor(
    readonly kind: SourceKind,
    container: HTMLElement,
    private readonly message: string,
  ) {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "relative aspect-video w-full bg-black";
    this.wrapper.dataset.testid = "unsupported-player";
    container.appendChild(this.wrapper);
  }

  load() {
    this.events.emit("loading");
    queueMicrotask(() => this.events.emit("error", { message: this.message }));
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
  seek() {}
  currentTime() {
    return 0;
  }
  duration() {
    return NaN;
  }
  playing() {
    return false;
  }
  ended() {
    return false;
  }
  ready() {
    return false;
  }
  canContinue() {
    return false;
  }
  seeking() {
    return false;
  }
  error() {
    return this.message;
  }
  setRate() {
    return false;
  }
  rate() {
    return 1;
  }
  setVolume() {}
  setMuted() {}
  on(listener: PlayerListener) {
    return this.events.on(listener);
  }
  destroy() {
    this.events.clear();
    this.wrapper.remove();
  }
}
