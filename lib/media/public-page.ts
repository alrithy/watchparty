import type { SourceKind } from "@/lib/room/types";
import { resolveSource } from "@/lib/media/source";

/**
 * Public HTML pages may advertise a playable video in Open Graph, Twitter,
 * VideoObject JSON-LD, HTML <video>/<source>, or a supported provider iframe.
 * This is deliberately metadata-only; it cannot execute JS, evade sign-in,
 * fetch protected video bytes or scrape arbitrary hidden player state.
 */

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (full, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#")) {
      const n = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : full;
    }
    return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<string, string>)[lower] ?? full;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rx = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(tag))) {
    const key = match[1].toLowerCase();
    if (!(key in out)) out[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

const mediaMeta = new Set(["og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream", "twitter:player:stream:url"]);
const mediaPaths = /\.(?:mp4|m4v|mov|webm|ogv|ogg|oga|mkv|avi|ts|m2ts|mts|wmv|flv|mp3|m4a|aac|flac|wav|opus|m3u8|mpd)$/i;

function asUrl(raw: unknown, base: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  try {
    const u = new URL(decodeEntities(raw.trim()), base);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || !u.hostname) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function isDirectOrProvider(input: string): boolean {
  const url = new URL(input);
  if (mediaPaths.test(url.pathname)) return true;
  const candidate = resolveSource(input);
  return candidate.ok && candidate.certain && (candidate.source.kind === "youtube" || candidate.source.kind === "vimeo");
}

/**
 * Candidate URLs from explicitly declared media metadata only. Results are
 * untrusted hints: the server must still apply its public-address guard before
 * any HEAD request and reject non-media target responses.
 */
export function publicPageCandidates(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  function add(raw: unknown, providerOnly = false) {
    const value = asUrl(raw, pageUrl);
    if (!value || seen.has(value) || (providerOnly && !isDirectOrProvider(value))) return;
    seen.add(value);
    found.push(value);
  }

  // OG/Twitter metadata and actual video elements, not arbitrary page <a>s.
  const tags = html.match(/<(?:meta|video|source|iframe|link)\b[^>]*>/gi) ?? [];
  for (const tag of tags.slice(0, 250)) {
    const name = /^<([a-z]+)/i.exec(tag)?.[1].toLowerCase();
    const attrs = attributes(tag);
    if (name === "meta") {
      if (mediaMeta.has((attrs.property ?? attrs.name ?? "").toLowerCase())) add(attrs.content);
    } else if (name === "video" || name === "source") {
      add(attrs.src ?? attrs["data-src"]);
    } else if (name === "iframe") {
      add(attrs.src, true);
    } else if (name === "link" && attrs.rel === "alternate" && /mpegurl|dash\+xml/i.test(attrs.type ?? "")) {
      add(attrs.href);
    }
  }

  // JSON-LD VideoObject contentUrl is an explicitly published playback URL.
  // Limit complexity and ignore "url" (usually the HTML page itself).
  const scripts = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let script: RegExpExecArray | null;
  let totalNodes = 0;
  while ((script = scripts.exec(html)) && totalNodes < 80) {
    if (script[1].length > 40_000) continue;
    try {
      const root: unknown = JSON.parse(script[1]);
      const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
      while (queue.length && totalNodes++ < 80) {
        const { node, depth } = queue.shift()!;
        if (depth > 5 || !node || typeof node !== "object") continue;
        if (Array.isArray(node)) {
          for (const child of node.slice(0, 16)) queue.push({ node: child, depth: depth + 1 });
        } else {
          const obj = node as Record<string, unknown>;
          const rawTypes = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
          if (rawTypes.some(t => typeof t === "string" && (t === "VideoObject" || t.endsWith("/VideoObject")))) {
            add(obj.contentUrl);
            add(obj.embedUrl, true);
          }
          for (const child of [obj["@graph"], obj.video, obj.mainEntity]) {
            if (child) queue.push({ node: child, depth: depth + 1 });
          }
        }
      }
    } catch { /* Bad JSON-LD is common; no executable evaluation. */ }
  }
  return found.slice(0, 8);
}

export function guessedMediaKind(candidate: string): SourceKind | null {
  const r = resolveSource(candidate);
  return r.ok && r.certain ? r.source.kind : null;
}
