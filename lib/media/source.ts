import type { MediaSource, SourceKind } from "@/lib/room/types";

export const INCOMPATIBLE_MESSAGE = "This source is not browser compatible.";
export const NOT_DIRECT_MESSAGE = "This source can't be played directly.";
export const STREAM_START_TIMEOUT_MESSAGE = "The stream didn't start loading.";
export const DRM_MESSAGE = "This video is DRM-protected, so Watch Party can't play it.";

const FILE_EXT = /\.(mp4|m4v|mov|webm|ogv|ogg|oga|mkv|avi|ts|m2ts|mts|wmv|flv|mp3|m4a|aac|flac|wav|opus)$/i;
/** Containers (and the codecs usually inside them) that <video> can't be trusted with: Movi plays these first. */
const MOVI_EXT = /\.(mkv|avi|ts|m2ts|mts|wmv|flv)$/i;
const HLS_EXT = /\.m3u8$/i;
const DASH_EXT = /\.mpd$/i;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

export type Resolved =
  | {
      ok: true;
      source: MediaSource;
      /** False when the URL gave no hint and a server probe may refine `kind`. */
      certain: boolean;
    }
  | { ok: false; error: string };

/** YouTube video id from any common URL shape, or null. */
export function youTubeId(url: URL): string | null {
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") id = url.searchParams.get("v");
    else if (["shorts", "embed", "live", "v", "e"].includes(parts[0] ?? "")) id = parts[1] ?? null;
  }
  return id && YT_ID.test(id) ? id : null;
}

export function isYouTubeHost(url: URL): boolean {
  return /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(url.hostname);
}

/** Vimeo id (and unlisted hash) from vimeo.com or player.vimeo.com URLs, or null. */
export function vimeoId(url: URL): { id: string; hash?: string } | null {
  const host = url.hostname.replace(/^www\./, "");
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.findIndex((p) => /^\d{6,12}$/.test(p));
  if (idx < 0) return null;
  // Showcases and albums contain several videos; a video id there isn't the page itself.
  if (["showcase", "album"].includes(parts[0] ?? "")) return null;
  const next = parts[idx + 1];
  const hash = url.searchParams.get("h") ?? (next && /^[0-9a-f]{6,20}$/i.test(next) ? next : undefined);
  return { id: parts[idx], ...(hash ? { hash } : {}) };
}

export function isVimeoHost(url: URL): boolean {
  return /(^|\.)vimeo\.com$/.test(url.hostname);
}

/** Display label without query strings, which often carry signed tokens. */
export function labelFor(input: string): string {
  try {
    const url = new URL(input);
    const file = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
    return file ? `${file} (${url.hostname})` : url.hostname;
  } catch {
    return "media";
  }
}

/**
 * Whether a direct file should start on Movi instead of <video>. Chrome opens
 * many MKVs and then plays them silently (AC-3/DTS) or without picture (HEVC),
 * which never raises an error to fall back on. The label carries the probed
 * file name for extensionless download links.
 */
export function prefersMovi(source: MediaSource): boolean {
  if (source.kind !== "file") return false;
  let path = "";
  try {
    path = new URL(source.url).pathname;
  } catch {}
  const name = source.label?.replace(/\s+\([^)]*\)$/, "") ?? "";
  return MOVI_EXT.test(path) || MOVI_EXT.test(name);
}

function kindFromPath(pathname: string): SourceKind | null {
  if (HLS_EXT.test(pathname)) return "hls";
  if (DASH_EXT.test(pathname)) return "dash";
  if (FILE_EXT.test(pathname)) return "file";
  return null;
}

/**
 * Works out which player a pasted URL needs, from the URL alone.
 * Unknown http(s) URLs default to the HTML5 player with `certain: false`.
 */
export function resolveSource(input: string): Resolved {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Paste a link to watch." };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "That doesn't look like a link." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: NOT_DIRECT_MESSAGE };
  }
  const href = url.toString();

  if (isYouTubeHost(url)) {
    const id = youTubeId(url);
    if (!id) return { ok: false, error: NOT_DIRECT_MESSAGE };
    return {
      ok: true,
      certain: true,
      source: { kind: "youtube", url: `https://www.youtube.com/watch?v=${id}`, videoId: id, label: `YouTube video ${id}` },
    };
  }
  if (isVimeoHost(url)) {
    const v = vimeoId(url);
    if (!v) return { ok: false, error: NOT_DIRECT_MESSAGE };
    return {
      ok: true,
      certain: true,
      source: {
        kind: "vimeo",
        url: `https://vimeo.com/${v.id}${v.hash ? `/${v.hash}` : ""}`,
        videoId: v.id,
        ...(v.hash ? { hash: v.hash } : {}),
        label: `Vimeo video ${v.id}`,
      },
    };
  }

  const kind = kindFromPath(url.pathname);
  // MediaWiki file pages (commons.wikimedia.org/wiki/File:Clip.webm) end in a media extension but are
  // HTML pages; the probe sees that and page discovery finds the <video> on them.
  const wikiPage = /\/wiki\/[^/]+:/.test(url.pathname);
  return { ok: true, certain: kind !== null && !wikiPage, source: { kind: kind ?? "file", url: href, label: labelFor(href) } };
}

export function describeMediaError(error: MediaError | null): string {
  if (!error) return "Playback failed.";
  switch (error.code) {
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
    case MediaError.MEDIA_ERR_DECODE:
      return INCOMPATIBLE_MESSAGE;
    case MediaError.MEDIA_ERR_NETWORK:
      return "Network error while loading the video. Check the link and try again.";
    case MediaError.MEDIA_ERR_ABORTED:
      return "Loading was aborted.";
    default:
      return "Playback failed.";
  }
}
