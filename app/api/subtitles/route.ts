import { fetchSmallFile } from "@/lib/media/probe";
import { isCrossSite } from "@/lib/http/same-origin";

const noStore = { "Cache-Control": "no-store, max-age=0" };
/** Subtitle files are text; a feature-length SRT is well under this. */
const MAX_BYTES = 2_000_000;

/**
 * POST { url } -> the subtitle file's bytes. Only used when the browser's own
 * fetch of a subtitle URL is blocked by CORS. Size-capped, so it can't relay media.
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
  const result = await fetchSmallFile(url, MAX_BYTES, { allowPrivate: process.env.PROBE_ALLOW_PRIVATE === "1" });
  if (!result.ok) return Response.json({ error: result.error }, { status: 502, headers: noStore });
  return new Response(result.bytes, {
    headers: { ...noStore, "Content-Type": "application/octet-stream" },
  });
}
