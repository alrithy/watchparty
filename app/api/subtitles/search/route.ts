import { isCrossSite } from "@/lib/http/same-origin";
import { anyProviderConfigured, findSubtitles, wantedFrom } from "@/lib/subtitles/search";
import { stripExtension } from "@/lib/subtitles/search/release";

const noStore = { "Cache-Control": "no-store, max-age=0" };
const OEMBED_TIMEOUT_MS = 4000;

type Body = { kind?: unknown; url?: unknown; videoId?: unknown; title?: unknown; diagnose?: unknown };

/** The page title of a YouTube/Vimeo video, via the providers' public oEmbed endpoints. */
async function oembedTitle(kind: string, videoId: string): Promise<string | null> {
  if (!/^[\w-]{1,32}$/.test(videoId)) return null;
  const endpoint =
    kind === "youtube"
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`
      : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${videoId}`)}`;
  try {
    const res = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: unknown };
    return typeof data.title === "string" ? data.title.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** Last path segment of a media URL; the query (often a signed token) is ignored. */
function fileNameOf(url: string): string | null {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!last) return null;
    // Some links encode the name twice ("Silo%2520S03E01.mp4").
    let name = decodeURIComponent(last);
    if (/%[0-9a-f]{2}/i.test(name)) {
      try {
        name = decodeURIComponent(name);
      } catch {}
    }
    // Only names that look like a release, not ids like "manifest.mpd" or a bare hash.
    return /[a-z]{2,}.*[.\s_-]/i.test(stripExtension(name)) ? name : null;
  } catch {
    return null;
  }
}

/**
 * POST { kind, url, videoId?, title?, diagnose? } -> ranked Arabic subtitles for
 * the room's video, with per-query diagnostics (counts and error codes only).
 * `title` is what the host typed when detection wasn't enough.
 */
export async function POST(request: Request) {
  if (isCrossSite(request)) return Response.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  if (!anyProviderConfigured()) {
    return Response.json({ error: "Subtitle search isn't set up on this server." }, { status: 503, headers: noStore });
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    body = {};
  }
  const kind = typeof body.kind === "string" ? body.kind : "";
  const url = typeof body.url === "string" && body.url.length <= 4096 ? body.url : "";
  const typed = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";

  let name: string | null = null;
  let fileName: string | null = null;
  if (typed) name = typed;
  else if ((kind === "youtube" || kind === "vimeo") && typeof body.videoId === "string") name = await oembedTitle(kind, body.videoId);
  else if (url) name = fileName = fileNameOf(url);
  const imdbId = (typed || url).match(/\btt\d{7,9}\b/)?.[0] ?? null;

  const wanted = wantedFrom({ name, fileName, imdbId });
  if (!wanted.title && !wanted.imdbId) {
    return Response.json({ needTitle: true, wanted: { title: null }, results: [], autoSelect: false, errors: [] }, { headers: noStore });
  }
  // diagnose: also run the fallback queries, to see what each returns.
  const result = await findSubtitles(wanted, { allQueries: body.diagnose === true });
  return Response.json({ needTitle: false, ...result }, { headers: noStore });
}
