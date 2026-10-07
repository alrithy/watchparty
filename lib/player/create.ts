import type { MediaSource } from "@/lib/room/types";
import type { PlayerAdapter } from "@/lib/player/types";
import { DashPlayerAdapter, HlsPlayerAdapter, Html5PlayerAdapter, type PlayerOptions } from "@/lib/player/html5";
import { YouTubePlayerAdapter } from "@/lib/player/youtube";
import { VimeoPlayerAdapter } from "@/lib/player/vimeo";

/** Picks the adapter for a source. Call `load(source)` after subscribing to its events. */
export function createPlayer(source: MediaSource, container: HTMLElement, opts: PlayerOptions): PlayerAdapter {
  switch (source.kind) {
    case "youtube":
      return new YouTubePlayerAdapter(container, opts);
    case "vimeo":
      return new VimeoPlayerAdapter(container, opts);
    case "hls":
      return new HlsPlayerAdapter(container, opts);
    case "dash":
      return new DashPlayerAdapter(container, opts);
    default:
      return new Html5PlayerAdapter(container, opts);
  }
}
