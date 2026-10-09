import "server-only";
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { isPublicAddress } from "@/lib/net/address";

/**
 * A minimal `fetch` for server-side requests to URLs that came from a user.
 *
 * Checking a hostname's addresses and then calling the global `fetch` leaves a
 * gap: fetch resolves the name again, and a DNS-rebinding host can answer with
 * a public address the first time and 127.0.0.1 or 169.254.169.254 the second.
 * Here the address check runs inside the socket's own DNS lookup, so the
 * connection can only ever be made to an address that passed the check (OWASP
 * SSRF cheat sheet, "DNS pinning"). IP-literal hosts are checked before the
 * socket opens.
 *
 * Deliberately small: one hop (callers follow redirects themselves and check
 * every hop), no cookies, no credentials, no proxy, no keep-alive. The body is
 * a web ReadableStream; callers cancel it after the bytes they need.
 */

export class BlockedAddressError extends Error {
  constructor() {
    super("Destination address is not allowed.");
    this.name = "BlockedAddressError";
  }
}

export type PinnedInit = {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Test-only: allow loopback/private destinations (local e2e). */
  allowPrivate?: boolean;
  /** Accept gzip/deflate/br and decode it (HTML pages). Off for media probes. */
  decompress?: boolean;
};

/** Mirrors the headers undici's fetch sent before, so proven CDNs see the same request. */
const DEFAULT_HEADERS: Record<string, string> = {
  accept: "*/*",
  "accept-language": "*",
  "user-agent": "node",
};

function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = (addresses as unknown as LookupAddress[]) ?? [];
      const allowed = allowPrivate ? list : list.filter((a) => isPublicAddress(a.address));
      // Refuse the host entirely if any address is non-public (a split answer is a rebinding tell).
      if (!allowed.length || allowed.length !== list.length) {
        return callback(new BlockedAddressError() as NodeJS.ErrnoException, "", 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, allowed);
      callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || k === "set-cookie") continue;
    out.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  return out;
}

function decoded(res: http.IncomingMessage): Readable {
  const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

export function pinnedFetch(input: string | URL, init: PinnedInit = {}): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input;
  if (url.protocol !== "https:" && url.protocol !== "http:") return Promise.reject(new BlockedAddressError());
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && !init.allowPrivate && !isPublicAddress(literal)) return Promise.reject(new BlockedAddressError());
  if (url.username || url.password) return Promise.reject(new BlockedAddressError());

  const transport = url.protocol === "https:" ? https : http;
  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
  // Never forward credentials to a user-chosen host, whatever a caller passed.
  delete headers.authorization;
  delete headers.cookie;
  delete headers["proxy-authorization"];
  headers["accept-encoding"] = init.decompress ? "gzip, deflate, br" : "identity";

  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) return reject(init.signal.reason ?? new DOMException("Aborted", "AbortError"));
    const req = transport.request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: guardedLookup(!!init.allowPrivate),
        agent: false,
        signal: init.signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const nullBody = init.method === "HEAD" || status === 204 || status === 205 || status === 304;
        if (nullBody) res.resume();
        const stream = nullBody ? null : init.decompress ? decoded(res) : res;
        stream?.on("error", () => {});
        try {
          resolve(
            new Response(stream ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>) : null, {
              status: status < 200 || status > 599 ? 502 : status,
              headers: toHeaders(res.headers),
            }),
          );
        } catch (e) {
          res.destroy();
          reject(e);
        }
      },
    );
    req.on("error", (e) => reject(init.signal?.aborted ? (init.signal.reason ?? e) : e));
    req.end();
  });
}

/** Adapts `pinnedFetch` to the `fetch` signature the probe and resolver take (tests inject their own). */
export function pinnedFetchImpl(allowPrivate = false, decompress = false): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input;
    const h = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    h.forEach((v, k) => (headers[k] = v));
    return pinnedFetch(url, {
      method: (init?.method as PinnedInit["method"]) ?? "GET",
      headers,
      signal: init?.signal ?? undefined,
      allowPrivate,
      decompress,
    });
  }) as typeof fetch;
}
