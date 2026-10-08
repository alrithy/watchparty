import type { MediaSource } from "@/lib/room/types";
import type { PlayerAdapter } from "@/lib/player/types";
import { capabilities as detect, type Capabilities } from "@/lib/media/capabilities";
import { planPlayback, routingFromLocation, type Routing } from "@/lib/media/route";
import { playbackDiagnostics } from "@/lib/media/diagnostics";
import { classifyFailure } from "@/lib/media/errors";
import { FallbackPlayer } from "@/lib/player/fallback";
import { MediaElementAdapter, type PlayerOptions } from "@/lib/player/media-element";
import { UnsupportedPlayer } from "@/lib/player/unsupported";
import { VimeoPlayerAdapter } from "@/lib/player/vimeo";

/**
 * Picks the adapter for a source on this device. Call `load(source)` after subscribing to its events.
 * `planPlayback` orders the engines from what the media is and what this
 * browser can do (e.g. Safari's own HLS before hls.js; Movi only where WebCodecs
 * exists); FallbackPlayer plays them, switching once on failure. YouTube and
 * Vimeo keep their provider players. Every attempt is recorded for the
 * diagnostics panel, without URLs.
 */
export function createPlayer(
  source: MediaSource,
  container: HTMLElement,
  opts: PlayerOptions,
  caps: Capabilities = detect(),
  routing: Routing = routingFromLocation(),
): PlayerAdapter {
  const plan = planPlayback(source, caps, routing);
  const session = playbackDiagnostics.begin(source, plan, caps, routing);
  if (!plan.engines.length) {
    const message = plan.unsupported ?? "This source can't be played on this device.";
    session.failed("ENGINE_UNAVAILABLE", message);
    return new UnsupportedPlayer(source.kind, container, message);
  }
  const first = plan.engines[0];
  if (first === "youtube" || first === "vimeo") {
    const p = first === "vimeo" ? new VimeoPlayerAdapter(container, opts) : new MediaElementAdapter("youtube", container, opts);
    session.attempt(first);
    p.on((e, detail) => {
      if (e === "ready") session.ready(null);
      else if (e === "playing") session.playing();
      else if (e === "error") session.failed(classifyFailure(first, detail?.message ?? ""), detail?.message ?? "Playback failed.");
    });
    return p;
  }
  const engines = plan.engines.filter((e): e is Exclude<typeof e, "youtube" | "vimeo"> => e !== "youtube" && e !== "vimeo");
  return new FallbackPlayer(container, opts, engines, undefined, { kind: source.kind, session });
}
