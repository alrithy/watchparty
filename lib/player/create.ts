import type { MediaSource } from "@/lib/room/types";
import type { PlayerAdapter } from "@/lib/player/types";
import { prefersMovi } from "@/lib/media/source";
import { FallbackPlayer } from "@/lib/player/fallback";
import { MediaElementAdapter, type PlayerOptions } from "@/lib/player/media-element";
import { VimeoPlayerAdapter } from "@/lib/player/vimeo";

/**
 * Picks the adapter for a source. Call `load(source)` after subscribing to its events.
 * HLS, DASH and YouTube use the media-element web components (the engines
 * react-player uses); Vimeo keeps its own because vimeo-video-element swallows
 * player errors and refused rate changes. Direct files try <video> and Movi
 * (MKV/HEVC/AC-3...) in the order the file suggests, switching once on failure.
 */
export function createPlayer(source: MediaSource, container: HTMLElement, opts: PlayerOptions): PlayerAdapter {
  if (source.kind === "vimeo") return new VimeoPlayerAdapter(container, opts);
  if (source.kind === "file") return new FallbackPlayer(container, opts, prefersMovi(source) ? ["movi", "native"] : ["native", "movi"]);
  return new MediaElementAdapter(source.kind, container, opts);
}
