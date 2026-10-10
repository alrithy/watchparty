import type { MediaSource } from "@/lib/room/types";
import { resolveSource } from "@/lib/media/source";

/**
 * Video providers a page can embed. Two lists:
 *
 * - Playable: an official player SDK Watch Party already drives with play,
 *   pause, seek and position (YouTube IFrame API, Vimeo Player SDK). An embed
 *   or oEmbed result on these turns into the room's normal YouTube/Vimeo source.
 * - Recognised only: well-known hosts we can name in the error, so the viewer
 *   reads "hosted on Dailymotion, not supported yet" instead of a generic
 *   failure. Adding an SDK adapter moves a provider to the first list (PR B).
 *
 * Only these providers' oEmbed endpoints are ever fetched; a page's own
 * `<link rel="alternate" type="application/json+oembed">` is followed only when
 * it points at one of them.
 */

type Provider = {
  name: string;
  /** Registrable domains, matched on the host and its subdomains. */
  hosts: string[];
  /** Official oEmbed endpoint (https only), when the provider publishes one. */
  oembed?: string;
  /** Subscription services whose video is DRM-protected: no web page can play it outside their app. */
  drm?: boolean;
  /**
   * Its pages carry a direct video in standard metadata (Streamable's og:video is an MP4),
   * so a pasted page is still discovered; only its embeds are named as unsupported.
   */
  pageHasMedia?: boolean;
};

export const PLAYABLE_PROVIDERS: Provider[] = [
  { name: "YouTube", hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"], oembed: "https://www.youtube.com/oembed" },
  { name: "Vimeo", hosts: ["vimeo.com"], oembed: "https://vimeo.com/api/oembed.json" },
];

export const RECOGNISED_PROVIDERS: Provider[] = [
  { name: "Dailymotion", hosts: ["dailymotion.com", "dai.ly"], oembed: "https://www.dailymotion.com/services/oembed" },
  { name: "Twitch", hosts: ["twitch.tv"] },
  { name: "Wistia", hosts: ["wistia.com", "wistia.net", "wi.st"], oembed: "https://fast.wistia.com/oembed" },
  { name: "Streamable", hosts: ["streamable.com"], oembed: "https://api.streamable.com/oembed.json", pageHasMedia: true },
  { name: "JW Player", hosts: ["jwplayer.com", "jwplatform.com", "jwpcdn.com"] },
  { name: "Brightcove", hosts: ["brightcove.net", "brightcove.com", "bcove.video"] },
  { name: "Kaltura", hosts: ["kaltura.com"] },
  { name: "Facebook", hosts: ["facebook.com", "fb.watch"] },
  { name: "Instagram", hosts: ["instagram.com"] },
  { name: "TikTok", hosts: ["tiktok.com"] },
  { name: "X", hosts: ["twitter.com", "x.com"] },
  { name: "Rumble", hosts: ["rumble.com"] },
  { name: "Bilibili", hosts: ["bilibili.com"] },
  { name: "Loom", hosts: ["loom.com"] },
  { name: "SoundCloud", hosts: ["soundcloud.com"] },
  { name: "Spotify", hosts: ["spotify.com"] },
  { name: "Netflix", hosts: ["netflix.com"], drm: true },
  { name: "Disney+", hosts: ["disneyplus.com"], drm: true },
  { name: "Prime Video", hosts: ["primevideo.com"], drm: true },
  { name: "Shahid", hosts: ["shahid.net", "shahid.mbc.net"], drm: true },
];

function onHost(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** The recognised (not yet playable) provider a URL belongs to. */
export function recognisedProvider(url: URL): { name: string; drm: boolean; pageHasMedia: boolean } | null {
  const p = RECOGNISED_PROVIDERS.find((p) => onHost(url.hostname, p.hosts));
  return p ? { name: p.name, drm: !!p.drm, pageHasMedia: !!p.pageHasMedia } : null;
}

/** Whether `endpoint` is one of the official oEmbed endpoints above (exact origin + path). */
export function isTrustedOembedEndpoint(endpoint: URL): boolean {
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port) return false;
  return [...PLAYABLE_PROVIDERS, ...RECOGNISED_PROVIDERS].some((p) => {
    if (!p.oembed) return false;
    const known = new URL(p.oembed);
    return known.host === endpoint.host && known.pathname.replace(/\.(json|xml)$/, "") === endpoint.pathname.replace(/\.(json|xml)$/, "");
  });
}

/**
 * An embed or watch URL (iframe src, JSON-LD embedUrl, og:video text/html,
 * oEmbed iframe) as a room source, when an official SDK we drive can play it.
 */
export function providerSource(url: string): MediaSource | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!PLAYABLE_PROVIDERS.some((p) => onHost(u.hostname, p.hosts))) return null;
  const r = resolveSource(u.href);
  return r.ok && (r.source.kind === "youtube" || r.source.kind === "vimeo") ? r.source : null;
}
