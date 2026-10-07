import { resolveStream } from "@/lib/media/resolve-stream";
import { isCrossSite } from "@/lib/http/same-origin";

const noStore = { "Cache-Control": "no-store, max-age=0" };

/**
 * POST { url } -> where the link's redirect chain ends (see lib/media/resolve-stream.ts).
 * Used when the browser couldn't read a file cross-origin, so it can retry on the
 * final CDN URL. Never returns or relays media bytes, and never logs the URL.
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
  if (typeof url !== "string" || url.length > 8192) {
    return Response.json({ error: "Missing url." }, { status: 400, headers: noStore });
  }
  const origin = request.headers.get("origin") ?? new URL(request.url).origin;
  const result = await resolveStream(url, { origin, allowPrivate: process.env.PROBE_ALLOW_PRIVATE === "1" });
  return Response.json(result, { headers: noStore });
}
