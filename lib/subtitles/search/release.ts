import ptt from "parse-torrent-title";

/**
 * What we know about a video or a subtitle's release, parsed from a release or
 * file name with parse-torrent-title (MIT), the JavaScript port of the
 * guessit-style PTN parser. Field names follow guessit's.
 */
export type ReleaseInfo = {
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  releaseGroup: string | null;
  source: string | null;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  streamingService: string | null;
};

const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|mov|avi|ts|m2ts|wmv|flv|ogv|m3u8|mpd)$/i;
const SUB_EXT = /\.(srt|vtt|sub|ass|ssa|zip)$/i;

/** Lowercase, accents stripped, punctuation to spaces: "Shōgun: Part 1" -> "shogun part 1". */
export function normalizeTitle(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** "x264"/"h264"/"avc" -> "H.264" etc., so names from different groups compare. */
function videoCodec(codec: string | undefined): string | null {
  if (!codec) return null;
  const c = codec.toLowerCase();
  if (/^(x|h)\.?264|avc/.test(c)) return "H.264";
  if (/^(x|h)\.?265|hevc/.test(c)) return "H.265";
  if (/av1/.test(c)) return "AV1";
  if (/xvid|divx/.test(c)) return "Xvid";
  return codec.toUpperCase();
}

/** Groups sources the way guessit does (WEB-DL vs WEBRip vs BluRay vs HDTV vs DVD). */
function source(src: string | undefined): string | null {
  if (!src) return null;
  const s = src.toLowerCase().replace(/[^a-z]/g, "");
  if (s === "webrip") return "WEBRip";
  if (s.startsWith("web")) return "WEB-DL";
  if (/bluray|bdrip|brrip|bdremux|bd/.test(s)) return "BluRay";
  if (/hdtv|pdtv|tvrip/.test(s)) return "HDTV";
  if (/dvd/.test(s)) return "DVD";
  return src;
}

function resolution(res: string | undefined): string | null {
  if (!res) return null;
  const r = res.toLowerCase();
  if (r === "4k" || r === "uhd") return "2160p";
  return r;
}

export function stripExtension(name: string): string {
  return name.replace(VIDEO_EXT, "").replace(SUB_EXT, "");
}

export function parseRelease(name: string): ReleaseInfo {
  const p = ptt.parse(stripExtension(name).trim());
  return {
    title: p.title?.trim() || null,
    year: p.year ?? null,
    season: p.season ?? null,
    episode: p.episode ?? null,
    releaseGroup: p.group?.trim() || null,
    source: source(p.source),
    resolution: resolution(p.resolution),
    videoCodec: videoCodec(p.codec),
    audioCodec: p.audio ? p.audio.toLowerCase() : null,
    streamingService: p.service ? p.service.toUpperCase() : null,
  };
}
