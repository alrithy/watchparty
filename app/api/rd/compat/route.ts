import { isCrossSite } from "@/lib/http/same-origin";
import { getRdAppleVariants, listRdDownloads, RdCompatError, validRdId } from "@/lib/realdebrid/compat";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
const bad = (code: string, message: string, status: number) =>
  Response.json({ error: { code, message } }, { status, headers });

/**
 * Opt-in, per-viewer RD compatibility lab only. API token arrives in the POST
 * body over TLS, is never persisted, logged or sent in a response. Signed HLS
 * URLs returned to the viewer are playback capabilities and must not be shared.
 * No Vercel media proxy, no room/host token, no public usage of RD credentials.
 */
export async function POST(request: Request) {
  if (isCrossSite(request)) return bad("FORBIDDEN", "Forbidden.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return bad("INVALID_REQUEST", "Expected JSON.", 415);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 8192) return bad("INVALID_REQUEST", "Request too large.", 413);
  let payload: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return bad("INVALID_REQUEST", "Request too large.", 413);
    payload = JSON.parse(raw);
  } catch { return bad("INVALID_REQUEST", "Invalid request.", 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return bad("INVALID_REQUEST", "Invalid request.", 400);
  const { action, token, id } = payload as { action?: unknown; token?: unknown; id?: unknown };
  if (typeof token !== "string" || token.length < 8 || token.length > 512 || !/^[^\s]+$/.test(token)) {
    return bad("INVALID_REQUEST", "Enter your own Real-Debrid API key.", 400);
  }
  try {
    if (action === "list") return Response.json({ downloads: await listRdDownloads(token) }, { headers });
    if (action === "variants") {
      if (!validRdId(id)) return bad("INVALID_REQUEST", "Select a valid Real-Debrid download ID.", 400);
      return Response.json({ result: await getRdAppleVariants(id, token) }, { headers });
    }
    return bad("INVALID_REQUEST", "Unknown action.", 400);
  } catch (e) {
    if (e instanceof RdCompatError) return bad(e.code, e.message, e.http);
    return bad("RD_UNAVAILABLE", "Unexpected provider error.", 502);
  }
}
