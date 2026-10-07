import "server-only";
import { unzipSync } from "fflate";
import type { Candidate, Wanted } from "@/lib/subtitles/search/score";
import { ProviderError } from "@/lib/subtitles/search/errors";

/**
 * SubDL API (https://subdl.com/api-doc). Strong Arabic coverage. The key is a
 * server-only environment variable. Downloads are zip files; we unzip with
 * fflate (MIT) and return the first .srt/.vtt inside.
 */
const API = "https://api.subdl.com/api/v1/subtitles";
const DL = "https://dl.subdl.com";
const TIMEOUT_MS = 8000;

export function subdlConfigured(): boolean {
  return !!process.env.SUBDL_API_KEY;
}

type SubdlSub = {
  release_name?: string | null;
  name?: string | null;
  language?: string | null;
  lang?: string | null;
  url?: string | null;
  season?: number | null;
  episode?: number | null;
  hi?: boolean | null;
  full_season?: boolean | null;
};
type SubdlResult = { name?: string | null; year?: number | null; imdb_id?: string | null };

const LANG_NAMES: Record<string, string> = { arabic: "ar", english: "en", french: "fr", farsi_persian: "fa", turkish: "tr" };

export function fromSubdl(sub: SubdlSub, feature: SubdlResult | undefined): Candidate[] {
  if (!sub.url || !/^\/subtitle\/[\w.-]+\.zip$/.test(sub.url) || sub.full_season) return [];
  const language = (sub.language ?? "").length === 2 ? sub.language!.toLowerCase() : LANG_NAMES[(sub.lang ?? "").toLowerCase()] ?? "";
  return [
    {
      provider: "subdl",
      id: sub.url,
      release: sub.release_name || sub.name || "",
      language,
      hearingImpaired: !!sub.hi,
      machineTranslated: false,
      downloads: 0,
      rating: null,
      trusted: false,
      fps: null,
      feature: {
        imdbId: feature?.imdb_id ?? null,
        title: feature?.name ?? null,
        year: feature?.year ?? null,
        season: sub.season ?? null,
        episode: sub.episode ?? null,
      },
    },
  ];
}

async function get(url: string): Promise<Response> {
  try {
    return await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("subdl", "SubDL didn't respond.");
  }
}

export async function searchSubdl(wanted: Wanted): Promise<Candidate[]> {
  const params = new URLSearchParams({ api_key: process.env.SUBDL_API_KEY ?? "", languages: wanted.language.toUpperCase(), subs_per_page: "30" });
  if (wanted.imdbId) params.set("imdb_id", wanted.imdbId);
  else if (wanted.title) params.set("film_name", wanted.title);
  else return [];
  const isEpisode = wanted.season != null || wanted.episode != null;
  params.set("type", isEpisode ? "tv" : "movie");
  if (wanted.season != null) params.set("season_number", String(wanted.season));
  if (wanted.episode != null) params.set("episode_number", String(wanted.episode));
  if (!isEpisode && wanted.year != null && !wanted.imdbId) params.set("year", String(wanted.year));
  const res = await get(`${API}?${params}`);
  if (res.status === 401 || res.status === 403) throw new ProviderError("subdl", "SubDL rejected our key.");
  if (res.status === 429) throw new ProviderError("subdl", "SubDL is rate limiting us. Try again later.");
  if (!res.ok) throw new ProviderError("subdl", `SubDL error ${res.status}.`);
  const data = (await res.json().catch(() => null)) as { status?: boolean; results?: SubdlResult[]; subtitles?: SubdlSub[] } | null;
  if (!data) throw new ProviderError("subdl", "SubDL sent an unreadable reply.");
  // SubDL answers "not found" with status:false.
  if (!data.status) return [];
  return (data.subtitles ?? []).flatMap((s) => fromSubdl(s, data.results?.[0]));
}

export async function downloadSubdl(id: string, maxBytes: number): Promise<ArrayBuffer> {
  if (!/^\/subtitle\/[\w.-]+\.zip$/.test(id)) throw new ProviderError("subdl", "Unknown subtitle.");
  const res = await get(`${DL}${id}`);
  if (!res.ok) throw new ProviderError("subdl", "Couldn't download that subtitle.");
  const zip = new Uint8Array(await res.arrayBuffer());
  if (zip.byteLength > maxBytes) throw new ProviderError("subdl", "That subtitle file is too large.");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, { filter: (f) => /\.(srt|vtt)$/i.test(f.name) && f.originalSize <= maxBytes });
  } catch {
    throw new ProviderError("subdl", "That subtitle archive is damaged.");
  }
  const name = Object.keys(files).sort()[0];
  if (!name) throw new ProviderError("subdl", "That archive has no .srt or .vtt file.");
  const file = files[name];
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}
