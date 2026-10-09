import { Parser } from "htmlparser2";
import type { DiscoveryVia } from "@/lib/media/discover/types";

/**
 * Reads the standard video metadata out of an HTML page without running it:
 * Open Graph (ogp.me), Twitter player cards, schema.org VideoObject in JSON-LD,
 * `<video>`/`<source>` elements, provider `<iframe>`s and oEmbed discovery links.
 *
 * htmlparser2 (MIT) tokenises the markup; nothing is rendered, no script runs,
 * and only attribute values and JSON-LD text are kept. Field selection follows
 * metascraper-video's rules (MIT, ideas only, no code copied) with candidates
 * kept separately instead of one winner, so the caller can verify and rank them.
 */

export type RawCandidate = {
  /** Absolute http(s) URL, resolved against the page (or its `<base href>`). */
  url: string;
  via: DiscoveryVia;
  /** "media": a file or manifest URL. "embed": an HTML player page (iframe src, embedUrl). */
  role: "media" | "embed";
  /** Declared MIME type, if any (og:video:type, <source type>, encodingFormat). */
  type?: string;
  width?: number;
  height?: number;
  title?: string;
  duration?: number;
  /** <video> that autoplays muted on a loop without controls: page decoration, not the content. */
  background?: boolean;
  /**
   * Which video this describes: "og", "tw", "ld:<n>" (n-th VideoObject), "video:<n>"
   * (n-th <video>; its <source>s are one video), "iframe:<n>". Used to tell one
   * video in several renditions from several different videos.
   */
  group: string;
};

export type PageMetadata = {
  title?: string;
  /** og:type is video.* */
  videoPage: boolean;
  canonical?: string;
  oembed: string[];
  candidates: RawCandidate[];
};

const MAX_CANDIDATES = 40;
const MAX_JSONLD_BYTES = 256 * 1024;
const MAX_JSONLD_BLOCKS = 12;
const MAX_TITLE = 160;

/** Plain text for display: no control or bidi-override characters, collapsed whitespace, bounded. */
export function cleanText(input: unknown, max = MAX_TITLE): string | undefined {
  if (typeof input !== "string") return undefined;
  const text = input
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** ISO 8601 duration (PT1H2M3S) or plain seconds → seconds. */
export function parseDuration(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) return input;
  if (typeof input !== "string") return undefined;
  if (/^\d+(\.\d+)?$/.test(input.trim())) return Number(input);
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(input.trim());
  if (!m || input.trim() === "P" || input.trim().toUpperCase() === "PT") return undefined;
  const s = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return s > 0 ? s : undefined;
}

function toInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : undefined;
}

function absolute(raw: unknown, base: URL): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 8192) return null;
  try {
    const u = new URL(value, base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function isVideoObject(node: Record<string, unknown>): boolean {
  const t = node["@type"];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && /(^|[/#:])VideoObject$/.test(x));
}

/** Every VideoObject in a JSON-LD document (top level, arrays, @graph, nested `video` properties). */
export function videoObjects(doc: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || out.length >= 20 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node.slice(0, 100)) walk(n, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (isVideoObject(obj)) out.push(obj);
    for (const [k, v] of Object.entries(obj)) {
      if (k === "@context") continue;
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(doc, 0);
  return out;
}

/** Media type hint from JSON-LD encodingFormat ("video/mp4", "mp4", "application/x-mpegURL"). */
function formatHint(v: unknown): string | undefined {
  const f = first(v);
  if (typeof f !== "string") return undefined;
  const s = f.trim().toLowerCase();
  if (/^[a-z]+\/[a-z0-9.+-]+$/.test(s)) return s;
  if (/^(mp4|webm|ogg|mov|m4v)$/.test(s)) return `video/${s === "mov" ? "quicktime" : s}`;
  return undefined;
}

type OgGroup = { url?: string; secure?: string; type?: string; width?: number; height?: number };

export function extractPage(html: string, pageUrl: string): PageMetadata {
  let base = new URL(pageUrl);
  const meta: PageMetadata = { videoPage: false, oembed: [], candidates: [] };
  let titleText = "";
  let inTitle = false;
  let ogTitle: string | undefined;
  let twTitle: string | undefined;
  const og: OgGroup[] = [];
  const twStream: { url?: string; type?: string; width?: number; height?: number } = {};
  let twPlayer: string | undefined;
  let jsonLd: string | null = null;
  let jsonLdCount = 0;
  const jsonLdTexts: string[] = [];
  let videoIndex = -1;
  let video: { src?: string; background: boolean; width?: number; height?: number; sources: number } | null = null;
  const iframes: string[] = [];

  const push = (c: RawCandidate) => {
    if (meta.candidates.length < MAX_CANDIDATES) meta.candidates.push(c);
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        switch (name) {
          case "base":
            if (attrs.href) {
              const b = absolute(attrs.href, base);
              if (b) base = new URL(b);
            }
            break;
          case "title":
            inTitle = !titleText;
            break;
          case "meta": {
            const key = (attrs.property ?? attrs.name ?? "").trim().toLowerCase();
            const content = attrs.content;
            if (!key || content === undefined) break;
            if (key === "og:title") ogTitle ??= content;
            else if (key === "twitter:title") twTitle ??= content;
            else if (key === "og:type") meta.videoPage ||= /^video(\.|$)/i.test(content.trim());
            else if (key === "og:video" || key === "og:video:url") {
              // A new root starts a new structured group, unless it repeats the current one's URL.
              const cur = og[og.length - 1];
              if (cur && !cur.url && cur.secure) cur.url = content;
              else og.push({ url: content });
            } else if (key === "og:video:secure_url") {
              const cur = og[og.length - 1];
              if (cur && !cur.secure) cur.secure = content;
              else og.push({ secure: content });
            } else if (key === "og:video:type" && og.length) og[og.length - 1].type ??= content.trim().toLowerCase();
            else if (key === "og:video:width" && og.length) og[og.length - 1].width ??= toInt(content);
            else if (key === "og:video:height" && og.length) og[og.length - 1].height ??= toInt(content);
            else if (key === "twitter:player") twPlayer ??= content;
            else if (key === "twitter:player:stream") twStream.url ??= content;
            else if (key === "twitter:player:stream:content_type") twStream.type ??= content.trim().toLowerCase();
            else if (key === "twitter:player:width") twStream.width ??= toInt(content);
            else if (key === "twitter:player:height") twStream.height ??= toInt(content);
            break;
          }
          case "link": {
            const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
            if (rel.includes("canonical") && !meta.canonical) meta.canonical = absolute(attrs.href, base) ?? undefined;
            if (rel.includes("alternate") && (attrs.type ?? "").toLowerCase() === "application/json+oembed") {
              const href = absolute(attrs.href, base);
              if (href && meta.oembed.length < 3) meta.oembed.push(href);
            }
            break;
          }
          case "script":
            if ((attrs.type ?? "").trim().toLowerCase() === "application/ld+json" && jsonLdCount < MAX_JSONLD_BLOCKS) {
              jsonLd = "";
              jsonLdCount++;
            }
            break;
          case "video": {
            videoIndex++;
            const has = (k: string) => k in attrs;
            video = {
              src: attrs.src,
              background: has("autoplay") && has("muted") && has("loop") && !has("controls"),
              width: toInt(attrs.width),
              height: toInt(attrs.height),
              sources: 0,
            };
            const src = absolute(attrs.src, base);
            if (src) push({ url: src, via: "video-tag", role: "media", type: attrs.type?.toLowerCase(), width: video.width, height: video.height, background: video.background, group: `video:${videoIndex}` });
            break;
          }
          case "source":
            if (video) {
              const src = absolute(attrs.src, base);
              video.sources++;
              // Wikimedia and others label each rendition's size (data-width/height, or res="720").
              const width = toInt(attrs["data-width"]) ?? toInt(attrs.width) ?? video.width;
              const height = toInt(attrs["data-height"]) ?? toInt(attrs.height) ?? toInt(attrs.res) ?? toInt(attrs.size) ?? video.height;
              if (src) push({ url: src, via: "video-tag", role: "media", type: attrs.type?.split(";")[0].trim().toLowerCase(), width, height, background: video.background, group: `video:${videoIndex}` });
            }
            break;
          case "iframe": {
            const src = absolute(attrs.src ?? attrs["data-src"], base);
            if (src && iframes.length < 20) iframes.push(src);
            break;
          }
        }
      },
      ontext(text) {
        if (inTitle && titleText.length < 1000) titleText += text;
        if (jsonLd !== null) {
          if (jsonLd.length + text.length > MAX_JSONLD_BYTES) jsonLd = null;
          else jsonLd += text;
        }
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
        if (name === "script" && jsonLd !== null) {
          jsonLdTexts.push(jsonLd);
          jsonLd = null;
        }
        if (name === "video") video = null;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  meta.title = cleanText(ogTitle) ?? cleanText(twTitle) ?? cleanText(titleText);

  let ldIndex = 0;
  for (const text of jsonLdTexts) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    for (const v of videoObjects(doc)) {
      const group = `ld:${ldIndex++}`;
      const title = cleanText(first(v.name));
      const duration = parseDuration(first(v.duration));
      const width = toInt(first(v.width));
      const height = toInt(first(v.height));
      const content = absolute(first(v.contentUrl), base);
      if (content) push({ url: content, via: "jsonld", role: "media", type: formatHint(v.encodingFormat), title, duration, width, height, group });
      const embed = absolute(first(v.embedUrl), base);
      if (embed) push({ url: embed, via: "jsonld", role: "embed", title, duration, group });
    }
  }

  for (const g of og) {
    const url = absolute(g.secure ?? g.url, base);
    if (!url) continue;
    const embed = g.type === "text/html" || g.type === "application/x-shockwave-flash";
    push({ url, via: "opengraph", role: embed ? "embed" : "media", type: g.type, width: g.width, height: g.height, title: meta.title, group: "og" });
  }

  const stream = absolute(twStream.url, base);
  if (stream) push({ url: stream, via: "twitter", role: "media", type: twStream.type, width: twStream.width, height: twStream.height, title: meta.title, group: "tw" });
  const player = absolute(twPlayer, base);
  if (player) push({ url: player, via: "twitter", role: "embed", title: meta.title, group: "tw" });

  iframes.forEach((src, i) => push({ url: src, via: "iframe", role: "embed", group: `iframe:${i}` }));

  return meta;
}
