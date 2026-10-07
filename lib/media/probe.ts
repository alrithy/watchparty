import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SourceKind } from "@/lib/room/types";

/**
 * Lightweight server-side check for URLs whose path gives no hint (e.g. CDN
 * download links). Reads response headers and at most a few KB, never the media.
 */

const TIMEOUT_MS = 6000;
export const MAX_REDIRECTS = 5;
const SNIFF_BYTES = 2048;
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

export type ProbeResult =
  /** A player that should handle it. */
  | { result: "playable"; kind: SourceKind; filename?: string }
  /** Definitely a web page or similar, not media. */
  | { result: "not_media" }
  /** Couldn't tell (blocked, auth, timeout...). The browser should just try. */
  | { result: "unknown" };

const HLS_TYPES = ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"];
const DASH_TYPES = ["application/dash+xml"];

function filenameFrom(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  const raw = star?.[1] ?? plain?.[1];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw.trim()).slice(0, 200);
  } catch {
    return raw.trim().slice(0, 200);
  }
}

/** Classifies a response from its headers and (optionally) its first bytes. */
export function classify(contentType: string | null, disposition: string | null, head?: string): ProbeResult {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const filename = filenameFrom(disposition);
  const sniff = head?.trimStart() ?? "";
  if (HLS_TYPES.includes(type) || sniff.startsWith("#EXTM3U")) return { result: "playable", kind: "hls", filename };
  if (DASH_TYPES.includes(type) || /^(<\?xml[^>]*>\s*)?<MPD[\s>]/.test(sniff)) {
    return { result: "playable", kind: "dash", filename };
  }
  if (type.startsWith("video/") || type.startsWith("audio/")) return { result: "playable", kind: "file", filename };
  if (filename && /\.m3u8$/i.test(filename)) return { result: "playable", kind: "hls", filename };
  if (filename && /\.mpd$/i.test(filename)) return { result: "playable", kind: "dash", filename };
  if (type === "application/octet-stream" || type === "binary/octet-stream" || filename) {
    return { result: "playable", kind: "file", filename };
  }
  if (type === "text/html" || type === "application/xhtml+xml" || type === "application/json") return { result: "not_media" };
  return { result: "unknown" };
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

export type ProbeOptions = { fetchImpl?: typeof fetch; resolve?: (host: string) => Promise<string[]>; allowPrivate?: boolean };

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

/** True when every address of `url`'s host is public and the scheme and port are allowed. */
export async function assertPublic(url: URL, opts: ProbeOptions): Promise<boolean> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // Test-only escape hatch (local e2e serves media from localhost:<port>).
  if (opts.allowPrivate) return true;
  if (!ALLOWED_PORTS.has(url.port)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  try {
    const addrs = isIP(host) ? [host] : await (opts.resolve ?? defaultResolve)(host);
    return addrs.length > 0 && !addrs.some(isPrivateAddress);
  } catch {
    return false;
  }
}

async function readHead(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  let out = new Uint8Array();
  try {
    while (out.length < SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const next = new Uint8Array(out.length + value.length);
      next.set(out);
      next.set(value, out.length);
      out = next;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(out.subarray(0, SNIFF_BYTES));
}

/** Follows redirects manually so every hop is checked against private addresses. */
async function request(start: URL, method: "HEAD" | "GET", opts: ProbeOptions, signal: AbortSignal, ranged = true) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await assertPublic(url, opts))) return null;
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method,
      redirect: "manual",
      signal,
      cache: "no-store",
      headers: method === "GET" && ranged ? { Range: `bytes=0-${SNIFF_BYTES - 1}` } : {},
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      void res.body?.cancel().catch(() => {});
      url = new URL(location, url);
      continue;
    }
    return res;
  }
  return null;
}

export async function probeUrl(input: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { result: "unknown" };
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const head = await request(url, "HEAD", opts, signal);
    // null: a hop was refused by the address guard (or too many redirects).
    if (!head) return { result: "unknown" };
    if (head.ok) {
      void head.body?.cancel().catch(() => {});
      const c = classify(head.headers.get("content-type"), head.headers.get("content-disposition"));
      if (c.result !== "unknown") return c;
    } else {
      void head.body?.cancel().catch(() => {});
    }
    // HEAD refused or inconclusive: ask for the first few KB only.
    const get = await request(url, "GET", opts, signal);
    if (!get) return { result: "unknown" };
    if (!get.ok) {
      void get.body?.cancel().catch(() => {});
      return { result: "unknown" };
    }
    const sniff = await readHead(get);
    return classify(get.headers.get("content-type"), get.headers.get("content-disposition"), sniff);
  } catch {
    return { result: "unknown" };
  }
}

/**
 * Fetches a small text file (subtitles) for a browser whose own fetch was
 * blocked by CORS. Same address guard as the probe; refuses anything larger
 * than `maxBytes`, so this never relays media.
 */
export async function fetchSmallFile(
  input: string,
  maxBytes: number,
  opts: ProbeOptions = {},
): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; error: string }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "That link isn't valid." };
  }
  try {
    const res = await request(url, "GET", opts, AbortSignal.timeout(TIMEOUT_MS), false);
    if (!res) return { ok: false, error: "That link can't be fetched." };
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, error: `The server answered ${res.status}.` };
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > maxBytes) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, error: "That file is too large for subtitles." };
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      total += value.length;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, error: "That file is too large for subtitles." };
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return { ok: true, bytes: out.buffer };
  } catch {
    return { ok: false, error: "That link can't be fetched." };
  }
}
