import "server-only";
import { unzipSync } from "fflate";
import type { Candidate, Wanted } from "@/lib/subtitles/search/score";
import { ProviderError } from "@/lib/subtitles/search/errors";
import type { QueryDiagnostics } from "@/lib/subtitles/search/diagnostics";
import { parseRelease } from "@/lib/subtitles/search/release";

/**
 * SubDL API (https://subdl.com/api-doc). Strong Arabic coverage. The key is a
 * server-only environment variable. Downloads are zip files; we unzip with
 * fflate (MIT) and return the .srt/.vtt inside (the requested episode's, for a
 * season pack).
 *
 * Search order for an episode: exact series + season + episode; then the
 * season's packs (`full_season=1`, `unpack=1`), keeping only files for the
 * requested episode; then, if both found nothing, the video's file name.
 */
const API = "https://api.subdl.com/api/v1/subtitles";
const DL = "https://dl.subdl.com";
const TIMEOUT_MS = 8000;

export function subdlConfigured(): boolean {
  return !!process.env.SUBDL_API_KEY;
}

type SubdlFile = {
  name?: string | null;
  file_name?: string | null;
  release_name?: string | null;
  url?: string | null;
  season?: number | string | null;
  episode?: number | string | null;
  language?: string | null;
  lang?: string | null;
};
export type SubdlSub = {
  release_name?: string | null;
  name?: string | null;
  language?: string | null;
  lang?: string | null;
  url?: string | null;
  season?: number | string | null;
  episode?: number | string | null;
  episode_from?: number | string | null;
  episode_end?: number | string | null;
  hi?: boolean | null;
  full_season?: boolean | null;
  releases?: unknown;
  unpack_files?: SubdlFile[] | null;
};
export type SubdlResult = { name?: string | null; year?: number | null; imdb_id?: string | null; type?: string | null };
type SubdlReply = {
  status?: boolean;
  statusCode?: number;
  error?: unknown;
  message?: unknown;
  results?: SubdlResult[];
  subtitles?: SubdlSub[];
};

const LANG_NAMES: Record<string, string> = {
  arabic: "ar",
  english: "en",
  french: "fr",
  farsi_persian: "fa",
  persian: "fa",
  turkish: "tr",
  spanish: "es",
  german: "de",
  italian: "it",
  portuguese: "pt",
  brazillian_portuguese: "pt",
  brazilian_portuguese: "pt",
  indonesian: "id",
  malay: "ms",
  urdu: "ur",
  hebrew: "he",
};

/** SubDL gives both a code ("AR") and a name ("arabic" / "Arabic"); either may be missing. */
export function subdlLanguage(sub: { language?: string | null; lang?: string | null }): string {
  const code = (sub.language ?? "").trim();
  if (/^[a-z]{2}$/i.test(code)) return code.toLowerCase();
  const name = (sub.lang ?? sub.language ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return LANG_NAMES[name] ?? "";
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The download path of a SubDL link: "/subtitle/123-456.zip" or, for a file
 * unpacked from a season pack, "/subtitle/<pack>/<file>". SubDL appends our API
 * key as a query string, so the query is always dropped here and the key is
 * added back only on the server when downloading. Anything else is refused.
 */
export function subdlPath(url: string | null | undefined): string | null {
  if (!url) return null;
  let path: string;
  try {
    const u = new URL(url, DL);
    if (u.origin !== DL) return null;
    path = u.pathname;
  } catch {
    return null;
  }
  return /^\/subtitle\/[\w.-]{1,80}(\/[\w.-]{1,120})?$/.test(path) && !path.includes("..") ? path : null;
}

/** A season pack's id names the episode to take out of the zip: "/subtitle/1-2.zip#S03E01". */
const EPISODE_TAG = /#S(\d{1,3})E(\d{1,4})$/;

function tag(season: number, episode: number): string {
  return `#S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export type Rejected = "bad_url" | "language" | "season_pack" | "other_episode";

/**
 * One SubDL subtitle as candidates. A season pack becomes candidates only for
 * its files that are the wanted episode (from `unpack_files`); a pack without
 * that list becomes one candidate for the wanted episode only when the pack
 * covers it, and the download step then picks that episode's file.
 */
export function fromSubdl(
  sub: SubdlSub,
  feature: SubdlResult | undefined,
  wanted?: Pick<Wanted, "season" | "episode">,
  reject?: (why: Rejected) => void,
): Candidate[] {
  const base = (over: Partial<Candidate> & Pick<Candidate, "id" | "release" | "language">, season: number | null, episode: number | null): Candidate => ({
    provider: "subdl",
    hearingImpaired: !!sub.hi,
    machineTranslated: false,
    downloads: 0,
    rating: null,
    trusted: false,
    fps: null,
    ...over,
    feature: {
      imdbId: feature?.imdb_id ?? null,
      title: feature?.name ?? null,
      year: feature?.year ?? null,
      season,
      episode,
    },
  });
  const language = subdlLanguage(sub);
  const release = sub.release_name || sub.name || "";
  const isPack = !!sub.full_season || (num(sub.episode_from) != null && num(sub.episode_end) != null && num(sub.episode_from) !== num(sub.episode_end));

  if (!isPack) {
    const id = subdlPath(sub.url);
    if (!id) {
      reject?.("bad_url");
      return [];
    }
    return [base({ id, release, language }, num(sub.season), num(sub.episode))];
  }

  // Season packs: only ever the wanted episode.
  if (wanted?.season == null || wanted.episode == null) {
    reject?.("season_pack");
    return [];
  }
  const files = Array.isArray(sub.unpack_files) ? sub.unpack_files : [];
  if (files.length) {
    const out: Candidate[] = [];
    for (const f of files) {
      const name = f.name || f.file_name || f.release_name || "";
      const rel = parseRelease(name);
      const season = num(f.season) ?? rel.season ?? num(sub.season);
      const episode = num(f.episode) ?? rel.episode;
      if (season !== wanted.season || episode !== wanted.episode) continue;
      const id = subdlPath(f.url);
      if (!id) {
        reject?.("bad_url");
        continue;
      }
      out.push(base({ id, release: name || release, language: subdlLanguage(f) || language }, season, episode));
    }
    if (!out.length) reject?.("other_episode");
    return out;
  }
  const from = num(sub.episode_from);
  const end = num(sub.episode_end);
  const season = num(sub.season) ?? parseRelease(release).season;
  const covers = season === wanted.season && (from == null || end == null || (wanted.episode >= from && wanted.episode <= end));
  const zip = subdlPath(sub.url);
  if (!covers) {
    reject?.("other_episode");
    return [];
  }
  if (!zip || !zip.endsWith(".zip")) {
    reject?.("bad_url");
    return [];
  }
  return [base({ id: zip + tag(wanted.season, wanted.episode), release, language }, wanted.season, wanted.episode)];
}

async function get(url: string): Promise<Response> {
  try {
    return await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("subdl", "SubDL didn't respond.");
  }
}

/** SubDL's "nothing found" replies, as opposed to real errors. */
function isNotFound(data: SubdlReply): boolean {
  const text = `${typeof data.error === "string" ? data.error : ""} ${typeof data.message === "string" ? data.message : ""}`.toLowerCase();
  return /not.?found|no (subtitles|results)|can.?t find|couldn.?t find/.test(text) || (!data.error && !data.message);
}

/** A short, safe code for an error reply (never the request URL or key). */
function errorCode(data: SubdlReply, status: number): string {
  const raw = typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : `http_${status}`;
  return raw.slice(0, 80).replace(/[^\w .:-]/g, "");
}

/** `strict`: keep only subtitles that name the wanted episode themselves (fallback queries). */
/** A download link's form with the query dropped and digits and letters masked ("/aaaaaaaa/9999-9999.aaa"), for diagnostics. */
function shape(url: unknown): string {
  if (typeof url !== "string") return typeof url;
  return url.split(/[?#]/)[0].slice(0, 120).replace(/[0-9]/g, "9").replace(/[a-z]/gi, "a");
}

type Query = { label: string; params: Record<string, string>; strict?: boolean };

async function run(q: Query, wanted: Wanted, diag: QueryDiagnostics[], sample = false): Promise<Candidate[]> {
  const params = new URLSearchParams({
    api_key: process.env.SUBDL_API_KEY ?? "",
    languages: wanted.language.toUpperCase(),
    subs_per_page: "30",
    ...q.params,
  });
  const d: QueryDiagnostics = { provider: "subdl", query: q.label, httpStatus: null, providerStatus: null, error: null, results: 0, subtitles: 0, accepted: 0, rejected: {} };
  diag.push(d);
  const res = await get(`${API}?${params}`);
  d.httpStatus = res.status;
  const data = (await res.json().catch(() => null)) as SubdlReply | null;
  d.providerStatus = data?.status ?? null;
  if (res.status === 401 || res.status === 403) {
    d.error = data ? errorCode(data, res.status) : `http_${res.status}`;
    throw new ProviderError("subdl", "SubDL rejected our key.");
  }
  if (res.status === 429) {
    d.error = "rate_limited";
    throw new ProviderError("subdl", "SubDL is rate limiting us. Try again later.");
  }
  if (!data) {
    d.error = res.ok ? "unreadable" : `http_${res.status}`;
    throw new ProviderError("subdl", res.ok ? "SubDL sent an unreadable reply." : `SubDL error ${res.status}.`);
  }
  if (!res.ok || data.status === false) {
    // "Not found" comes back as status:false (sometimes with a 404); everything else is a real error.
    if (isNotFound(data) && (res.ok || res.status === 404)) {
      d.error = data.error || data.message ? errorCode(data, res.status) : null;
      return [];
    }
    d.error = errorCode(data, res.status);
    throw new ProviderError("subdl", `SubDL error: ${d.error}.`);
  }
  const subs = Array.isArray(data.subtitles) ? data.subtitles : [];
  d.results = Array.isArray(data.results) ? data.results.length : 0;
  d.subtitles = subs.length;
  const feature = data.results?.[0];
  if (sample) {
    d.sample = subs.slice(0, 4).map((s) => ({
      keys: Object.keys(s),
      release_name: s.release_name ?? null,
      lang: s.lang ?? null,
      language: s.language ?? null,
      season: s.season ?? null,
      episode: s.episode ?? null,
      episode_from: s.episode_from ?? null,
      episode_end: s.episode_end ?? null,
      full_season: s.full_season ?? null,
      url: shape(s.url),
      unpack: Array.isArray(s.unpack_files)
        ? s.unpack_files.slice(0, 3).map((f) => ({ keys: Object.keys(f), name: f.name ?? null, season: f.season ?? null, episode: f.episode ?? null, url: shape(f.url) }))
        : null,
    }));
  }
  const out: Candidate[] = [];
  for (const s of subs) {
    const cands = fromSubdl(s, feature, wanted, (why) => (d.rejected[why] = (d.rejected[why] ?? 0) + 1));
    for (const c of cands) {
      if (c.language !== wanted.language) d.rejected.language = (d.rejected.language ?? 0) + 1;
      else if (q.strict && !namesWantedEpisode(c, wanted)) d.rejected.other_episode = (d.rejected.other_episode ?? 0) + 1;
      else out.push(c);
    }
  }
  d.accepted = out.length;
  return out;
}

function namesWantedEpisode(c: Candidate, wanted: Wanted): boolean {
  if (wanted.season == null && wanted.episode == null) return true;
  const rel = parseRelease(c.release);
  const season = c.feature.season ?? rel.season;
  const episode = c.feature.episode ?? rel.episode;
  return (wanted.season == null || season === wanted.season) && (wanted.episode == null || episode === wanted.episode);
}

function identity(wanted: Wanted): Record<string, string> | null {
  if (wanted.imdbId) return { imdb_id: wanted.imdbId };
  if (wanted.title) return { film_name: wanted.title };
  return null;
}

/** The SubDL queries for this video, in the order they're tried. */
export function subdlQueries(wanted: Wanted): Query[] {
  const id = identity(wanted);
  const isEpisode = wanted.season != null || wanted.episode != null;
  const queries: Query[] = [];
  if (id && isEpisode) {
    const se: Record<string, string> = {};
    if (wanted.season != null) se.season_number = String(wanted.season);
    if (wanted.episode != null) se.episode_number = String(wanted.episode);
    queries.push({ label: "episode", params: { ...id, type: "tv", ...se } });
    if (wanted.season != null && wanted.episode != null) {
      queries.push({ label: "season_pack", params: { ...id, type: "tv", season_number: String(wanted.season), full_season: "1", unpack: "1" }, strict: true });
    }
  } else if (id) {
    const movie: Record<string, string> = { ...id, type: "movie" };
    if (wanted.year != null && !wanted.imdbId) movie.year = String(wanted.year);
    queries.push({ label: "movie", params: movie });
  }
  if (wanted.fileName) queries.push({ label: "file_name", params: { file_name: wanted.fileName }, strict: true });
  return queries;
}

/**
 * Tries the queries in order and stops at the first that yields candidates.
 * `all` runs every query (diagnostics only). Errors are thrown, never turned into "nothing found".
 */
export async function searchSubdl(wanted: Wanted, diag: QueryDiagnostics[] = [], all = false): Promise<Candidate[]> {
  const queries = subdlQueries(wanted);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const q of queries) {
    const found = await run(q, wanted, diag, all);
    for (const c of found) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    if (out.length && !all) break;
  }
  return out;
}

/** Picks the subtitle file from a zip: the requested episode's for a season pack, else the first .srt/.vtt. */
export function pickFromZip(files: Record<string, Uint8Array>, episode: { season: number; episode: number } | null): string | null {
  const names = Object.keys(files).sort();
  if (!episode) return names[0] ?? null;
  return (
    names.find((n) => {
      const r = parseRelease(n.split("/").pop() ?? n);
      return r.season === episode.season && r.episode === episode.episode;
    }) ??
    names.find((n) => {
      const r = parseRelease(n.split("/").pop() ?? n);
      return r.season == null && r.episode === episode.episode;
    }) ??
    null
  );
}

export async function downloadSubdl(id: string, maxBytes: number): Promise<ArrayBuffer> {
  const m = EPISODE_TAG.exec(id);
  const path = m ? id.slice(0, m.index) : id;
  if (subdlPath(path) !== path || !path.startsWith("/")) throw new ProviderError("subdl", "Unknown subtitle.");
  // SubDL's links carry the API key; it is added here, on the server, and never leaves it.
  const res = await get(`${DL}${path}?${new URLSearchParams({ api_key: process.env.SUBDL_API_KEY ?? "" })}`);
  if (!res.ok) throw new ProviderError("subdl", "Couldn't download that subtitle.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes * 10) throw new ProviderError("subdl", "That subtitle file is too large.");
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    if (bytes.byteLength > maxBytes) throw new ProviderError("subdl", "That subtitle file is too large.");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => /\.(srt|vtt)$/i.test(f.name) && f.originalSize <= maxBytes });
  } catch {
    throw new ProviderError("subdl", "That subtitle archive is damaged.");
  }
  const name = pickFromZip(files, m ? { season: Number(m[1]), episode: Number(m[2]) } : null);
  if (!name) throw new ProviderError("subdl", m ? "That season pack has no file for this episode." : "That archive has no .srt or .vtt file.");
  const file = files[name];
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}
