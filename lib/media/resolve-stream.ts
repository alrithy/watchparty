import "server-only";
import { assertPublic, fetcherFor, MAX_REDIRECTS, type ProbeOptions } from "@/lib/media/probe";

/**
 * Follows a media link's redirect chain on the server and returns where it ends,
 * so the browser can open the final CDN URL directly. Every hop is fetched with
 * `redirect: "manual"`, checked against the same public-address guard as the
 * probe, and asked for one byte (`Range: bytes=0-0`); bodies are cancelled
 * unread. No cookies or Authorization headers are sent, and nothing is logged.
 */

const TIMEOUT_MS = 9000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type ResolveFailure = "invalid" | "blocked" | "too_many_redirects" | "loop" | "timeout" | "unreachable" | "http_error";

export type ResolveResult =
  | {
      ok: true;
      originalUrl: string;
      finalUrl: string;
      redirected: boolean;
      hops: number;
      status: number;
      /** 206 to the one-byte request; null when the answer doesn't say. */
      supportsRange: boolean | null;
      contentType: string | null;
      /** Whether the final response allows `origin` to read it (Access-Control-Allow-Origin). */
      cors: "allowed" | "missing" | "unknown";
    }
  | { ok: false; originalUrl: string; reason: ResolveFailure; status?: number };

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export async function resolveStream(input: string, opts: ProbeOptions & { origin?: string; timeoutMs?: number } = {}): Promise<ResolveResult> {
  const originalUrl = input.trim();
  const first = parse(originalUrl);
  if (!first || (first.protocol !== "https:" && first.protocol !== "http:")) {
    return { ok: false, originalUrl, reason: "invalid" };
  }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  // `raw` is the URL exactly as the server gave it (signed query strings untouched); `url` is for checks.
  let raw = originalUrl;
  let url = first;
  const seen = new Set<string>();
  try {
    for (let hop = 0; ; hop++) {
      if (!(await assertPublic(url, opts))) return { ok: false, originalUrl, reason: "blocked" };
      seen.add(url.href);
      const res = await fetcherFor(opts)(raw, {
        method: "GET",
        redirect: "manual",
        signal,
        cache: "no-store",
        credentials: "omit",
        headers: { Range: "bytes=0-0", ...(opts.origin ? { Origin: opts.origin } : {}) },
      });
      void res.body?.cancel().catch(() => {});
      const location = res.headers.get("location");
      if (REDIRECTS.has(res.status) && location) {
        if (hop >= MAX_REDIRECTS) return { ok: false, originalUrl, reason: "too_many_redirects" };
        const next = ABSOLUTE.test(location) ? parse(location) : parse(new URL(location, url).href);
        if (!next || (next.protocol !== "https:" && next.protocol !== "http:")) {
          return { ok: false, originalUrl, reason: "blocked" };
        }
        if (seen.has(next.href)) return { ok: false, originalUrl, reason: "loop" };
        raw = ABSOLUTE.test(location) ? location : next.href;
        url = next;
        continue;
      }
      if (res.status >= 400) return { ok: false, originalUrl, reason: "http_error", status: res.status };
      const allow = res.headers.get("access-control-allow-origin");
      return {
        ok: true,
        originalUrl,
        finalUrl: raw,
        redirected: hop > 0,
        hops: hop,
        status: res.status,
        supportsRange: res.status === 206 ? true : res.status === 200 ? false : null,
        contentType: res.headers.get("content-type"),
        cors: !opts.origin ? "unknown" : allow === "*" || allow === opts.origin ? "allowed" : "missing",
      };
    }
  } catch (e) {
    const timedOut = signal.aborted || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
    return { ok: false, originalUrl, reason: timedOut ? "timeout" : "unreachable" };
  }
}
