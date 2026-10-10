import "server-only";
import type { MediaSource, SourceKind } from "@/lib/room/types";
import { assertPublic, classify, MAX_REDIRECTS, probeUrl, type ProbeOptions } from "@/lib/media/probe";
import { labelFor, resolveSource } from "@/lib/media/source";
import { pinnedFetchImpl } from "@/lib/net/pinned-fetch";
import { extractPage, type RawCandidate } from "@/lib/media/discover/extract";
import { isTrustedOembedEndpoint, providerSource, recognisedProvider } from "@/lib/media/discover/providers";
import { DISCOVERY_MESSAGES, unsupported, type DiscoveredOption, type DiscoveryResult } from "@/lib/media/discover/types";

/**
 * Finds the video on a pasted web page, safely:
 *
 *   page URL → known provider? → fetch HTML (bounded) → metadata candidates
 *   → official provider embeds / trusted oEmbed → verify media candidates
 *   with the header probe → one source, a short list to pick from, or a reason.
 *
 * Every request goes through the same guard as the probe (http/https, allowed
 * ports, public addresses only, checked on every redirect hop and pinned at
 * connect time), sends no cookies or credentials, and reads at most
 * PAGE_MAX_BYTES of HTML or OEMBED_MAX_BYTES of JSON. Media bytes are never
 * read beyond the probe's 2 KB sniff. Nothing here logs URLs.
 */

export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const OEMBED_MAX_BYTES = 64 * 1024;
const PAGE_TIMEOUT_MS = 8000;
const OEMBED_TIMEOUT_MS = 4000;
/** Media candidates verified per page (in parallel). */
const MAX_VERIFY = 4;
/** Options shown in the picker. */
const MAX_OPTIONS = 6;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** An honest name, so site owners can tell a user-pasted link check from a crawler. */
const USER_AGENT = "Mozilla/5.0 (compatible; WatchPartyLinkCheck/1.0; +https://github.com/alrithy/watchparty)";

const AD_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "imasdk.googleapis.com",
  "adnxs.com",
  "amazon-adsystem.com",
  "taboola.com",
  "outbrain.com",
  "springserve.com",
  "spotxchange.com",
  "teads.tv",
  "moatads.com",
  "adsafeprotected.com",
  "criteo.com",
  "pubmatic.com",
  "innovid.com",
];
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico)$/i;

export type DiscoverOptions = ProbeOptions & {
  /** Header probe for media candidates (tests inject a scripted one). */
  probe?: typeof probeUrl;
};

type Fetched =
  | { ok: true; url: URL; res: Response }
  | { ok: false; result: DiscoveryResult; playable?: MediaSource };

function onHost(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function isAdOrImage(url: string): boolean {
  try {
    const u = new URL(url);
    return onHost(u.hostname.toLowerCase(), AD_HOSTS) || IMAGE_EXT.test(u.pathname) || /(^|[/?&_.-])(vast|vpaid)([/?&_.=-]|$)/i.test(u.pathname + u.search);
  } catch {
    return true;
  }
}

function statusResult(status: number): DiscoveryResult {
  if (status === 401 || status === 407) return unsupported("AUTH_REQUIRED");
  // Live testing: most 403s on public pages are bot protection (Cloudflare, Akamai) refusing a
  // datacenter request, not a login wall. We don't try to get around it; we say what happened.
  if (status === 403) return unsupported("SOURCE_UNAVAILABLE", DISCOVERY_MESSAGES.REFUSED);
  if (status === 404 || status === 410) return unsupported("LINK_EXPIRED");
  return unsupported("SOURCE_UNAVAILABLE");
}

function timedOut(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
}

/** GET with manual redirects; every hop passes the address guard. Returns the final response unread. */
async function fetchGuarded(start: URL, accept: string, opts: DiscoverOptions, signal: AbortSignal): Promise<Fetched> {
  const fetcher = opts.fetchImpl ?? pinnedFetchImpl(!!opts.allowPrivate, true);
  let url = start;
  const seen = new Set<string>();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await assertPublic(url, opts))) return { ok: false, result: unsupported("BLOCKED_DESTINATION") };
    // A redirect to a provider we can play (short links, "watch on" pages) ends discovery there.
    if (hop > 0) {
      const provider = providerSource(url.href);
      if (provider) return { ok: false, result: unsupported("PAGE_NOT_MEDIA"), playable: provider };
    }
    seen.add(url.href);
    let res: Response;
    try {
      res = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        signal,
        cache: "no-store",
        credentials: "omit",
        headers: { accept, "user-agent": USER_AGENT, "accept-language": "en, ar;q=0.8, *;q=0.5" },
      });
    } catch (e) {
      if (e instanceof Error && e.name === "BlockedAddressError") return { ok: false, result: unsupported("BLOCKED_DESTINATION") };
      return { ok: false, result: unsupported(timedOut(e, signal) ? "NETWORK_TIMEOUT" : "SOURCE_UNAVAILABLE") };
    }
    const location = res.headers.get("location");
    if (REDIRECTS.has(res.status) && location) {
      void res.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { ok: false, result: unsupported("SOURCE_UNAVAILABLE") };
      }
      if (seen.has(next.href)) return { ok: false, result: unsupported("SOURCE_UNAVAILABLE") };
      url = next;
      continue;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, result: statusResult(res.status) };
    }
    return { ok: true, url, res };
  }
  return { ok: false, result: unsupported("SOURCE_UNAVAILABLE") };
}

/** Reads at most `max` bytes of a body as text (a longer body is cut there, never buffered whole). */
async function readText(res: Response, max: number): Promise<string> {
  // Only a prefix is read: a huge or missing Content-Length doesn't matter, the bytes we hold are bounded.
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const room = max - total;
      chunks.push(value.length > room ? value.subarray(0, room) : value);
      total += Math.min(value.length, room);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  const charset = /charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** The iframe a trusted oEmbed endpoint returns for the page, as a playable provider source. Never renders its HTML. */
async function viaOembed(endpoints: string[], opts: DiscoverOptions, signal: AbortSignal): Promise<{ source: MediaSource; title?: string } | null> {
  for (const raw of endpoints) {
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      continue;
    }
    if (!isTrustedOembedEndpoint(endpoint)) continue;
    endpoint.searchParams.set("format", "json");
    const got = await fetchGuarded(endpoint, "application/json", opts, AbortSignal.any([signal, AbortSignal.timeout(OEMBED_TIMEOUT_MS)]));
    if (!got.ok) continue;
    const text = await readText(got.res, OEMBED_MAX_BYTES);
    if (!text || text.length >= OEMBED_MAX_BYTES) continue;
    let data: { html?: unknown; title?: unknown; type?: unknown };
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || typeof data.html !== "string" || data.html.length > OEMBED_MAX_BYTES) continue;
    // Only the iframe's src is used, and only if it is a provider we drive with its official SDK.
    const frames = extractPage(data.html, endpoint.href).candidates.filter((c) => c.via === "iframe");
    for (const f of frames) {
      const source = providerSource(f.url);
      if (source) return { source, title: typeof data.title === "string" ? data.title : undefined };
    }
  }
  return null;
}

/**
 * Among renditions of one video the biggest isn't the best: a 4K original stalls phones. When the
 * page says how tall each is, prefer the tallest at or under 1080p (worth less than any via weight).
 */
function renditionScore(c: RawCandidate): number {
  if (!c.height) return 0;
  return c.height > 1080 ? -8 : (3 * c.height) / 1080;
}

const VIA_WEIGHT: Record<RawCandidate["via"], number> = { jsonld: 50, opengraph: 40, twitter: 35, oembed: 30, "video-tag": 20, iframe: 10 };

function kindFor(url: string, type: string | undefined, probed?: SourceKind): SourceKind {
  if (probed) return probed;
  const r = resolveSource(url);
  if (r.ok && r.certain) return r.source.kind;
  if (type && /mpegurl/i.test(type)) return "hls";
  if (type === "application/dash+xml") return "dash";
  return "file";
}

/** URL path or declared type says "media" even though the server couldn't confirm it. */
function looksLikeMedia(c: RawCandidate): boolean {
  const r = resolveSource(c.url);
  if (r.ok && r.certain && (r.source.kind === "file" || r.source.kind === "hls" || r.source.kind === "dash")) return true;
  return !!c.type && /^(video\/|audio\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml))/i.test(c.type);
}

function sourceFor(url: string, kind: SourceKind, label: string, via: RawCandidate["via"], pageHost: string, mime?: string): MediaSource {
  return { kind, url, label, ...(mime ? { mime } : {}), page: { host: pageHost, via } };
}

/**
 * Ranks a page's candidates into one main video, several, or none. Pure: the
 * caller supplies verification results so this is unit-testable.
 */
export function choose(
  candidates: RawCandidate[],
  verified: Map<string, { kind: SourceKind; mime?: string; verified: boolean }>,
  page: { host: string; title?: string; videoPage: boolean },
): DiscoveredOption[] {
  // Multiple VideoObjects with different names describe a list of videos, not one.
  const ldGroups = new Set(candidates.filter((c) => c.group.startsWith("ld:")).map((c) => c.group));
  const ldNames = new Set(candidates.filter((c) => c.group.startsWith("ld:")).map((c) => c.title ?? c.group));
  const oneLd = ldGroups.size <= 1 || ldNames.size <= 1;
  const identity = (c: RawCandidate) => (c.group === "og" || c.group === "tw" || (oneLd && c.group.startsWith("ld:")) ? "main" : c.group);

  type Scored = DiscoveredOption & { score: number; identity: string };
  const scored: Scored[] = [];
  const seenUrls = new Set<string>();
  const videoElements = new Set(candidates.filter((c) => c.via === "video-tag" && !c.background).map((c) => c.group));

  for (const c of candidates) {
    if (seenUrls.has(c.url)) continue;
    let option: DiscoveredOption | null = null;
    if (c.role === "embed") {
      const source = providerSource(c.url);
      if (source) option = { source: { ...source, page: { host: page.host, via: c.via } }, via: c.via, title: c.title ?? page.title, duration: c.duration, verified: true };
    } else {
      const v = verified.get(c.url);
      if (v && !c.background) {
        const title = c.title ?? page.title;
        option = {
          source: sourceFor(c.url, v.kind, title ?? labelFor(c.url), c.via, page.host, v.mime),
          via: c.via,
          title,
          duration: c.duration,
          verified: v.verified,
        };
      }
    }
    if (!option) continue;
    seenUrls.add(c.url);
    let score = VIA_WEIGHT[c.via] + (option.verified ? 20 : 0) + (page.videoPage ? 5 : 0);
    if (c.via === "video-tag") score += videoElements.size === 1 ? 10 : -10;
    score += renditionScore(c);
    scored.push({ ...option, score, identity: identity(c) });
  }

  // One option per video: the best-scored rendition of each identity.
  const best = new Map<string, Scored>();
  for (const s of scored) {
    const cur = best.get(s.identity);
    if (!cur || s.score > cur.score) best.set(s.identity, s);
  }
  // A <video> or iframe playing the same URL as the main metadata is the same video.
  const main = best.get("main");
  const all = [...best.values()].sort((a, b) => b.score - a.score);
  if (main && (main.verified || all.every((o) => o === main || !o.verified))) return [strip(main)];
  return all.slice(0, MAX_OPTIONS).map(strip);
}

function strip(o: DiscoveredOption & { score?: number; identity?: string }): DiscoveredOption {
  const { score: _s, identity: _i, ...rest } = o;
  void _s;
  void _i;
  return rest;
}

export async function discoverPage(input: string, opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  let start: URL;
  try {
    start = new URL(input.trim());
  } catch {
    return unsupported("PAGE_NOT_MEDIA", "That doesn't look like a link.");
  }
  if (start.protocol !== "https:" && start.protocol !== "http:") return unsupported("BLOCKED_DESTINATION");

  // Known services first: no request needed to say what we can't do.
  const known = recognisedProvider(start);
  // (Providers whose pages carry a direct video are discovered like any page.)
  if (known?.drm) return unsupported("DRM_LICENSE_REQUIRED", `${known.name} videos are DRM-protected, so Watch Party can't play them.`);
  if (known && !known.pageHasMedia) return unsupported("NO_EMBED_AVAILABLE", `This video is on ${known.name}, which Watch Party can't play in sync yet.`);

  const signal = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  const page = await fetchGuarded(start, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", opts, signal);
  if (!page.ok) {
    if (page.playable) return { result: "source", option: { source: page.playable, via: "iframe", verified: true } };
    return page.result;
  }
  const host = page.url.hostname;
  const type = (page.res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  // The "page" turned out to be media after all (a redirect to a file, a mislabelled probe).
  const asMedia = classify(page.res.headers.get("content-type"), page.res.headers.get("content-disposition"));
  if (asMedia.result === "playable") {
    void page.res.body?.cancel().catch(() => {});
    const source: MediaSource = { kind: asMedia.kind, url: input.trim(), label: labelFor(input.trim()), ...(asMedia.contentType ? { mime: asMedia.contentType } : {}) };
    return { result: "source", option: { source, via: "video-tag", verified: true } };
  }
  if (type !== "text/html" && type !== "application/xhtml+xml" && type !== "") {
    void page.res.body?.cancel().catch(() => {});
    return unsupported("PAGE_NOT_MEDIA");
  }

  let html: string;
  try {
    html = await readText(page.res, PAGE_MAX_BYTES);
  } catch (e) {
    return unsupported(timedOut(e, signal) ? "NETWORK_TIMEOUT" : "SOURCE_UNAVAILABLE");
  }
  const meta = extractPage(html, page.url.href);
  const candidates = meta.candidates.filter((c) => !isAdOrImage(c.url));

  // Verify media candidates with the header probe (strongest first, a few at a time).
  const media = candidates
    .filter((c) => c.role === "media" && !c.background)
    .sort((a, b) => VIA_WEIGHT[b.via] + renditionScore(b) - (VIA_WEIGHT[a.via] + renditionScore(a)))
    .filter((c, i, list) => list.findIndex((x) => x.url === c.url) === i)
    .slice(0, MAX_VERIFY);
  const probe = opts.probe ?? probeUrl;
  const verified = new Map<string, { kind: SourceKind; mime?: string; verified: boolean }>();
  await Promise.all(
    media.map(async (c) => {
      const r = await probe(c.url, opts).catch(() => ({ result: "unknown" as const }));
      if (r.result === "playable") verified.set(c.url, { kind: kindFor(c.url, c.type, r.kind), mime: r.contentType, verified: true });
      // The media host refused or ignored the server (IP-bound or bot-blocked CDNs): keep it only when
      // the URL or declared type plainly says media. The player's own start-up checks have the last word.
      else if (r.result === "unknown" && looksLikeMedia(c)) verified.set(c.url, { kind: kindFor(c.url, c.type), verified: false });
    }),
  );

  let options = choose(candidates, verified, { host, title: meta.title, videoPage: meta.videoPage });

  if (!options.length && meta.oembed.length) {
    const viaO = await viaOembed(meta.oembed, opts, signal).catch(() => null);
    if (viaO) {
      options = [{ source: { ...viaO.source, page: { host, via: "oembed" } }, via: "oembed", title: meta.title ?? viaO.title, verified: true }];
    }
  }

  // Play straight away only when confident: a verified video from the page's own metadata or its one
  // <video>. A lone iframe (could be a sidebar clip) or an unconfirmed URL is shown for the host to confirm.
  if (options.length === 1 && options[0].verified && options[0].via !== "iframe") return { result: "source", option: options[0] };
  if (options.length) return { result: "choose", options };

  // Nothing playable: name the provider when the page embeds a known one.
  for (const c of candidates) {
    if (c.role !== "embed") continue;
    try {
      const p = recognisedProvider(new URL(c.url));
      if (p?.drm) return unsupported("DRM_LICENSE_REQUIRED", `This page's video is on ${p.name}, which is DRM-protected.`);
      if (p) return unsupported("NO_EMBED_AVAILABLE", `This page's video is on ${p.name}, which Watch Party can't play in sync yet.`);
    } catch {}
  }
  return unsupported("PAGE_NOT_MEDIA", DISCOVERY_MESSAGES.PAGE_NOT_MEDIA);
}
