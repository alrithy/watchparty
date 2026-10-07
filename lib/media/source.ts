import type { MediaSource, PlaybackMode } from "@/lib/room/types";
import type { ResolvedMedia } from "@/lib/realdebrid/types";

export function isHls(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return false;
  }
}

/** Validates a user-entered direct URL. Returns an error message or null. */
export function validateMediaUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return "Enter a full URL starting with http:// or https://";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "Only http(s) URLs are supported";
  }
  return null;
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

export function makeSource(mode: PlaybackMode, url: string): MediaSource {
  return { mode, url: url.trim(), label: labelFor(url.trim()) };
}

/** Room source for a link the server resolved with the host's Real-Debrid account. */
export function makeHostRdSource(media: ResolvedMedia): MediaSource {
  return { mode: "host-rd", url: media.url, label: `${media.filename} (Real-Debrid)` };
}

/** Asks the server to resolve a hoster link. The Real-Debrid token stays on the server. */
export async function resolveHostRd(link: string): Promise<{ media: ResolvedMedia } | { error: string }> {
  try {
    const res = await fetch("/api/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link: link.trim() }),
    });
    const body = (await res.json().catch(() => null)) as
      | { media?: ResolvedMedia; error?: { message?: string } }
      | null;
    if (res.ok && body?.media) return { media: body.media };
    return { error: body?.error?.message ?? `Couldn't resolve the link (HTTP ${res.status}).` };
  } catch {
    return { error: "Couldn't reach the server. Check your connection and try again." };
  }
}

export const INCOMPATIBLE_MESSAGE = "This source is not browser compatible.";

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
