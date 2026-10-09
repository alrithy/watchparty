import type { MediaSource } from "@/lib/room/types";

/** Where a page's video was found, strongest first. */
export type DiscoveryVia = NonNullable<MediaSource["page"]>["via"];

/**
 * Why a pasted page gave no playable video. Stable codes for diagnostics and
 * tests; each comes with a sentence the viewer can act on.
 */
export type DiscoveryErrorCode =
  /** The page loaded but declares no video we could find. */
  | "PAGE_NOT_MEDIA"
  /** The video is on a provider we recognise but have no synchronised player for yet. */
  | "NO_EMBED_AVAILABLE"
  /** The provider forbids playing this video outside its own site. */
  | "PROVIDER_EMBED_BLOCKED"
  /** The page or its video needs a login (401/403). */
  | "AUTH_REQUIRED"
  /** A subscription service whose video is DRM-protected. */
  | "DRM_LICENSE_REQUIRED"
  /** The page or video is gone (404/410), or a signed link expired. */
  | "LINK_EXPIRED"
  | "NETWORK_TIMEOUT"
  /** The site errored, refused us, or is unreachable. */
  | "SOURCE_UNAVAILABLE"
  /** The link points at a private or otherwise disallowed address. */
  | "BLOCKED_DESTINATION"
  | "RATE_LIMITED";

/** One playable choice found on a page. `source.url` is the media URL exactly as the page gave it. */
export type DiscoveredOption = {
  source: MediaSource;
  via: DiscoveryVia;
  /** Media title from the page metadata, sanitised plain text. */
  title?: string;
  /** Seconds, when the page declares it. */
  duration?: number;
  /** The server fetched the media URL and saw a media response (not just a URL in metadata). */
  verified: boolean;
};

export type DiscoveryResult =
  | { result: "source"; option: DiscoveredOption }
  /** Several different videos and no clear main one: the host picks. */
  | { result: "choose"; options: DiscoveredOption[] }
  | { result: "unsupported"; code: DiscoveryErrorCode; message: string };

export const DISCOVERY_MESSAGES: Record<DiscoveryErrorCode, string> = {
  PAGE_NOT_MEDIA: "This page doesn't contain a video Watch Party can find. Try copying the video's own link.",
  NO_EMBED_AVAILABLE: "This page's video is on a site Watch Party can't play in sync yet.",
  PROVIDER_EMBED_BLOCKED: "The video's owner doesn't allow it to be played outside their site.",
  AUTH_REQUIRED: "This page needs a login, so Watch Party can't see its video. Copy the video's direct link instead.",
  DRM_LICENSE_REQUIRED: "This service's videos are DRM-protected, so Watch Party can't play them.",
  LINK_EXPIRED: "That page or video is no longer available. If it was a signed link, get a fresh one.",
  NETWORK_TIMEOUT: "The page took too long to answer. Try again.",
  SOURCE_UNAVAILABLE: "The site didn't answer properly. Try again, or copy the video's own link.",
  BLOCKED_DESTINATION: "That link points to a private network address, which Watch Party won't open.",
  RATE_LIMITED: "Too many links checked in a short time. Wait a minute and try again.",
};

export function unsupported(code: DiscoveryErrorCode, message = DISCOVERY_MESSAGES[code]): DiscoveryResult {
  return { result: "unsupported", code, message };
}
