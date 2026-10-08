import { hostToken } from "@/lib/realdebrid/client";
import { redactUrl, resolveHostLink, validateHostLink } from "@/lib/realdebrid/resolve";
import type { HostRdError } from "@/lib/realdebrid/types";
import { isCrossSite } from "@/lib/http/same-origin";

const noStore = { "Cache-Control": "no-store, max-age=0" };

function fail(error: HostRdError) {
  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: noStore });
}

/**
 * Host Real-Debrid: POST { link } -> { media: { url, filename, mimeType, filesize } }.
 * The token never leaves the server; the browser streams `url` straight from Real-Debrid.
 */
export async function POST(request: Request) {
  if (isCrossSite(request)) {
    return Response.json({ error: { code: "forbidden", message: "Forbidden." } }, { status: 403, headers: noStore });
  }
  const token = hostToken();
  if (!token) {
    return fail({ code: "not_configured", status: 503, message: "Host Real-Debrid isn't configured on this server." });
  }

  let link: unknown;
  try {
    link = ((await request.json()) as { link?: unknown })?.link;
  } catch {
    link = undefined;
  }
  const invalid = validateHostLink(link);
  if (invalid) return fail(invalid);

  const result = await resolveHostLink(link as string, { token });
  if (!result.ok) {
    console.warn(
      `[resolve] failed code=${result.error.code} rd_code=${result.error.rdCode ?? "-"} source=${redactUrl(link as string)}`,
    );
    return fail(result.error);
  }
  console.info(`[resolve] ok source=${redactUrl(link as string)} media=${redactUrl(result.media.url)} remote=${result.remote ? 1 : 0}`);
  return Response.json({ media: result.media }, { headers: noStore });
}
