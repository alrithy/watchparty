import { probeUrl } from "@/lib/media/probe";
import { isCrossSite } from "@/lib/http/same-origin";

const noStore = { "Cache-Control": "no-store, max-age=0" };

/**
 * POST { url } -> { result: "playable", kind, filename? } | { result: "not_media" } | { result: "unknown" }.
 * Used only for pasted URLs whose path doesn't say what they are. Reads headers
 * and at most 2 KB; media itself always streams browser -> origin.
 */
export async function POST(request: Request) {
  if (isCrossSite(request)) {
    return Response.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  }
  let url: unknown;
  try {
    url = ((await request.json()) as { url?: unknown })?.url;
  } catch {
    url = undefined;
  }
  if (typeof url !== "string" || url.length > 4096) {
    return Response.json({ error: "Missing url." }, { status: 400, headers: noStore });
  }
  const result = await probeUrl(url, { allowPrivate: process.env.PROBE_ALLOW_PRIVATE === "1" });
  return Response.json(result, { headers: noStore });
}
