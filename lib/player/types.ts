import type { MediaSource, SourceKind } from "@/lib/room/types";

/**
 * Events every adapter emits, in HTML5 media terms. The sync engine only
 * listens to these, so it never needs to know which provider is playing.
 */
export type PlayerEvent =
  | "loading" // a source started loading
  | "ready" // metadata known; seeking is possible
  | "play" // playback was requested (user or API)
  | "playing" // frames are actually advancing
  | "pause"
  | "seeked"
  | "waiting" // stalled for data
  | "canplay" // enough data to continue
  | "ended"
  | "error";

export type PlayerListener = (event: PlayerEvent, detail?: { message?: string }) => void;

export interface PlayerAdapter {
  readonly kind: SourceKind;
  /** Lead added to sync seeks to absorb how long a seek takes on this player. */
  readonly seekLead: number;
  load(source: MediaSource): void;
  /** Rejects with a DOMException named "NotAllowedError" when autoplay is blocked. */
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  currentTime(): number;
  /** Seconds, or NaN when unknown. */
  duration(): number;
  playing(): boolean;
  ended(): boolean;
  /** Metadata is loaded, so position and seeking are meaningful. */
  ready(): boolean;
  /** Not stalled: enough data to keep playing. */
  canContinue(): boolean;
  seeking(): boolean;
  /** Whether `seconds` is already buffered, so seeking there is instant (optional). */
  isBuffered?(seconds: number): boolean;
  /** Last fatal error, shown to the user. */
  error(): string | null;
  /** Small rate nudges for drift correction. Returns false where the provider can't do fine-grained rates. */
  setRate(rate: number): boolean;
  rate(): number;
  /** Local listening preferences; never synced. */
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  on(listener: PlayerListener): () => void;
  destroy(): void;
}

/** Tiny event hub shared by the adapters. */
export class Emitter {
  private listeners = new Set<PlayerListener>();
  on(listener: PlayerListener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  emit(event: PlayerEvent, detail?: { message?: string }) {
    for (const l of this.listeners) l(event, detail);
  }
  clear() {
    this.listeners.clear();
  }
}

export const notAllowed = () => new DOMException("Playback needs a user gesture", "NotAllowedError");
