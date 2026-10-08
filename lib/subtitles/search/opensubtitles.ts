import "server-only";
import type { Candidate, Wanted } from "@/lib/subtitles/search/score";
import { ProviderError } from "@/lib/subtitles/search/errors";

/**
 * OpenSubtitles REST API (https://opensubtitles.stoplight.io/). The API key,
 * and the optional account used to raise the download quota, are server-only
 * environment variables; signed download links never leave this module.
 */
const API = "https://api.opensubtitles.com/api/v1";
const USER_AGENT = "WatchParty v0.3";
const TIMEOUT_MS = 8000;

export function openSubtitlesConfigured(): boolean {
  return !!process.env.OPENSUBTITLES_API_KEY;
}

function headers(token?: string): HeadersInit {
  return {
    "Api-Key": process.env.OPENSUBTITLES_API_KEY ?? "",
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("opensubtitles", "OpenSubtitles didn't respond.");
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError("opensubtitles", "OpenSubtitles rejected our key.");
  if (res.status === 406 || res.status === 429) throw new ProviderError("opensubtitles", "OpenSubtitles download limit reached. Try again later.");
  if (!res.ok) throw new ProviderError("opensubtitles", `OpenSubtitles error ${res.status}.`);
  return res.json().catch(() => {
    throw new ProviderError("opensubtitles", "OpenSubtitles sent an unreadable reply.");
  });
}

let session: { token: string; until: number } | null = null;

/** Logging in is optional; it raises the daily download quota. Tokens last 24 h; we reuse one for 12. */
async function token(): Promise<string | undefined> {
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!username || !password) return undefined;
  if (session && session.until > Date.now()) return session.token;
  try {
    const data = (await call("/login", { method: "POST", headers: headers(), body: JSON.stringify({ username, password }) })) as {
      token?: string;
    };
    if (data.token) session = { token: data.token, until: Date.now() + 12 * 3600_000 };
  } catch {
    session = null; // fall back to anonymous downloads
  }
  return session?.token;
}

type OsFile = { file_id?: number; file_name?: string | null };
type OsItem = {
  attributes?: {
    language?: string | null;
    download_count?: number | null;
    hearing_impaired?: boolean | null;
    machine_translated?: boolean | null;
    ai_translated?: boolean | null;
    foreign_parts_only?: boolean | null;
    fps?: number | null;
    ratings?: number | null;
    from_trusted?: boolean | null;
    release?: string | null;
    files?: OsFile[];
    feature_details?: {
      feature_type?: string | null;
      title?: string | null;
      movie_name?: string | null;
      parent_title?: string | null;
      year?: number | null;
      imdb_id?: number | null;
      parent_imdb_id?: number | null;
      season_number?: number | null;
      episode_number?: number | null;
    } | null;
  };
};

/** Turns one /subtitles result into candidates (one per file; multi-CD sets are skipped). */
export function fromOpenSubtitles(item: OsItem): Candidate[] {
  const a = item.attributes;
  if (!a || a.foreign_parts_only) return [];
  const files = (a.files ?? []).filter((f): f is Required<OsFile> => typeof f.file_id === "number");
  if (files.length !== 1) return [];
  const f = a.feature_details ?? {};
  const isEpisode = f.feature_type === "Episode";
  const imdb = isEpisode ? f.parent_imdb_id : f.imdb_id;
  return [
    {
      provider: "opensubtitles",
      id: String(files[0].file_id),
      release: a.release || files[0].file_name || "",
      language: (a.language ?? "").toLowerCase().slice(0, 2),
      hearingImpaired: !!a.hearing_impaired,
      machineTranslated: !!(a.machine_translated || a.ai_translated),
      downloads: a.download_count ?? 0,
      rating: a.ratings ?? null,
      trusted: !!a.from_trusted,
      fps: a.fps || null,
      feature: {
        imdbId: imdb ? `tt${String(imdb).padStart(7, "0")}` : null,
        title: (isEpisode ? f.parent_title : f.title ?? f.movie_name) ?? null,
        year: f.year ?? null,
        season: f.season_number ?? null,
        episode: f.episode_number ?? null,
      },
    },
  ];
}

export async function searchOpenSubtitles(wanted: Wanted): Promise<Candidate[]> {
  const params: Record<string, string> = { languages: wanted.language };
  if (wanted.imdbId) params.imdb_id = wanted.imdbId.replace(/^tt0*/i, "");
  else if (wanted.title) params.query = wanted.title.toLowerCase();
  else return [];
  if (wanted.season != null) params.season_number = String(wanted.season);
  if (wanted.episode != null) params.episode_number = String(wanted.episode);
  if (wanted.season != null || wanted.episode != null) params.type = "episode";
  else {
    params.type = "movie";
    if (wanted.year != null && !wanted.imdbId) params.year = String(wanted.year);
  }
  // The API redirects unless parameters are sorted and lowercase.
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const data = (await call(`/subtitles?${qs}`, { headers: headers() })) as { data?: OsItem[] };
  return (data.data ?? []).flatMap(fromOpenSubtitles);
}

/** Returns the subtitle file's bytes. The signed link is used here and dropped. */
export async function downloadOpenSubtitles(id: string, maxBytes: number): Promise<ArrayBuffer> {
  if (!/^\d{1,12}$/.test(id)) throw new ProviderError("opensubtitles", "Unknown subtitle.");
  const data = (await call("/download", {
    method: "POST",
    headers: headers(await token()),
    body: JSON.stringify({ file_id: Number(id), sub_format: "srt" }),
  })) as { link?: string };
  if (!data.link || !/^https:\/\//.test(data.link)) throw new ProviderError("opensubtitles", "OpenSubtitles didn't give a download.");
  let res: Response;
  try {
    res = await fetch(data.link, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("opensubtitles", "Couldn't download that subtitle.");
  }
  if (!res.ok) throw new ProviderError("opensubtitles", "Couldn't download that subtitle.");
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
    throw new ProviderError("opensubtitles", "That subtitle file is too large.");
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new ProviderError("opensubtitles", "That subtitle file is too large.");
  return bytes;
}
