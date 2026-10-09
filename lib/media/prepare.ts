import type { MediaSource } from "@/lib/room/types";
import { NOT_DIRECT_MESSAGE, resolveSource } from "@/lib/media/source";
import type { DiscoveredOption, DiscoveryErrorCode, DiscoveryResult } from "@/lib/media/discover/types";
import { recognisedProvider } from "@/lib/media/discover/providers";

type ProbeResponse =
  | { result: "playable"; kind: MediaSource["kind"]; filename?: string; contentType?: string }
  | { result: "not_media" }
  | { result: "unknown" };

export type Prepared =
  | { source: MediaSource }
  /** A web page with several different videos: the host picks one. */
  | { choose: DiscoveredOption[] }
  | { error: string; code?: DiscoveryErrorCode };

/** Asks the server to find the video on a web page (only after the probe said "not media"). */
async function discover(url: string): Promise<Prepared> {
  try {
    const res = await fetch("/api/media/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok && res.status !== 429) return { error: NOT_DIRECT_MESSAGE };
    const found = (await res.json()) as DiscoveryResult;
    if (found.result === "source") return { source: found.option.source };
    if (found.result === "choose") return { choose: found.options };
    return { error: found.message, code: found.code };
  } catch {
    return { error: NOT_DIRECT_MESSAGE };
  }
}

/**
 * Turns whatever the host pasted into a room source. The URL decides when it
 * can (direct files, HLS, DASH, YouTube, Vimeo: no request at all); otherwise
 * the server peeks at the headers. A web page goes on to page discovery. If
 * the probe can't tell, the HTML5 player gets a try and reports its own error.
 */
export async function prepareSource(input: string): Promise<Prepared> {
  const resolved = resolveSource(input);
  if (!resolved.ok) return { error: resolved.error };
  if (resolved.certain) return { source: resolved.source };
  // Services we know but can't play in sync yet (or that are DRM-only): say so without any request.
  const known = recognisedProvider(new URL(resolved.source.url));
  if (known?.drm) return { error: `${known.name} videos are DRM-protected, so Watch Party can't play them.`, code: "DRM_LICENSE_REQUIRED" };
  if (known) return { error: `This video is on ${known.name}, which Watch Party can't play in sync yet.`, code: "NO_EMBED_AVAILABLE" };
  try {
    const res = await fetch("/api/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: resolved.source.url }),
    });
    if (!res.ok) return { source: resolved.source };
    const probe = (await res.json()) as ProbeResponse;
    if (probe.result === "not_media") return discover(resolved.source.url);
    if (probe.result === "playable") {
      const host = new URL(resolved.source.url).hostname;
      return {
        source: {
          ...resolved.source,
          kind: probe.kind,
          ...(probe.filename ? { label: `${probe.filename} (${host})` } : {}),
          ...(probe.contentType ? { mime: probe.contentType } : {}),
        },
      };
    }
  } catch {
    // Probe unavailable: let the browser try.
  }
  return { source: resolved.source };
}
