import { discoverPage } from "@/lib/media/discover/discover";
import { unsupported } from "@/lib/media/discover/types";
import { isCrossSite } from "@/lib/http/same-origin";
import { clientKey, RateLimiter } from "@/lib/http/rate-limit";

const noStore = { "Cache-Control": "no-store, max-age=0" };

/** 20 page checks per client per minute; at most 8 running at once on this instance. */
const limiter = new RateLimiter(20, 60_000, 8);

/**
 * POST { url } -> DiscoveryResult (see lib/media/discover/types.ts).
 * Called only after the probe said a pasted link is a web page, not media.
 * Reads at most 2 MB of the page's HTML and the media candidates' headers;
 * never returns page HTML, never relays media, never logs the URL.
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
  const slot = limiter.acquire(clientKey(request));
  if (!slot.ok) {
    return Response.json(unsupported("RATE_LIMITED"), { status: 429, headers: { ...noStore, "Retry-After": "60" } });
  }
  try {
    const result = await discoverPage(url, { allowPrivate: process.env.PROBE_ALLOW_PRIVATE === "1" });
    return Response.json(result, { headers: noStore });
  } finally {
    slot.release();
  }
}
