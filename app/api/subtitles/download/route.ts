import { isCrossSite } from "@/lib/http/same-origin";
import { downloadSubtitle, isProvider } from "@/lib/subtitles/search";
import { ProviderError } from "@/lib/subtitles/search/errors";

const noStore = { "Cache-Control": "no-store, max-age=0" };
const MAX_BYTES = 2_000_000;

/** POST { provider, id } -> the subtitle file's bytes. Provider links and keys stay on the server. */
export async function POST(request: Request) {
  if (isCrossSite(request)) return Response.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  let body: { provider?: unknown; id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!isProvider(body.provider) || typeof body.id !== "string" || body.id.length > 200) {
    return Response.json({ error: "Unknown subtitle." }, { status: 400, headers: noStore });
  }
  try {
    const bytes = await downloadSubtitle(body.provider, body.id, MAX_BYTES);
    return new Response(bytes, { headers: { ...noStore, "Content-Type": "application/octet-stream" } });
  } catch (e) {
    const message = e instanceof ProviderError ? e.message : "Couldn't download that subtitle.";
    return Response.json({ error: message }, { status: 502, headers: noStore });
  }
}
