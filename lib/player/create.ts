import type { MediaSource } from "@/lib/room/types";
import type { PlayerAdapter } from "@/lib/player/types";
import { MediaElementAdapter, type PlayerOptions } from "@/lib/player/media-element";
import { VimeoPlayerAdapter } from "@/lib/player/vimeo";

/**
 * Picks the adapter for a source. Call `load(source)` after subscribing to its events.
 * Files, HLS, DASH and YouTube share one adapter over the media-element web
 * components (the engines react-player uses); Vimeo keeps its own because
 * vimeo-video-element swallows player errors and refused rate changes.
 */
export function createPlayer(source: MediaSource, container: HTMLElement, opts: PlayerOptions): PlayerAdapter {
  if (source.kind === "vimeo") return new VimeoPlayerAdapter(container, opts);
  return new MediaElementAdapter(source.kind, container, opts);
}
