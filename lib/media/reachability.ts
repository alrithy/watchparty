import type { PlaybackErrorCode } from "@/lib/media/errors";

/**
 * After every engine on this device failed, a small check of whether the failure was
 * the network or the video itself. Engines report reachability problems in decoder
 * words (Safari's <video> says MEDIA_ERR_SRC_NOT_SUPPORTED for a host it can't connect
 * to), so the verdict comes from two one-byte requests instead:
 *
 * - from this browser: a CORS `Range: bytes=0-0` read, and when that throws, a
 *   `no-cors` request. An opaque answer means the server replied (status hidden);
 *   a second throw means no reply reached this device at all.
 * - from Watch Party's server: the existing header-only resolver (`/api/media/resolve`,
 *   same SSRF guard, bodies cancelled unread, nothing logged).
 *
 * No bytes are relayed and nothing is retried through the server. Only status codes
 * and outcomes are kept; the URL never leaves this module except in the two requests.
 */

const CHECK_TIMEOUT_MS = 6000;

export type BrowserReach =
  /** This page read the first byte (2xx/206). */
  | { result: "readable"; status: number }
  /** This page read an error status (the server sent CORS headers with it). */
  | { result: "http"; status: number }
  /** The server answered, but not readably from this page: CORS, or an answer without CORS headers. */
  | { result: "answered" }
  /** No answer reached this device: DNS, TLS, connection refused or reset. */
  | { result: "unreachable" }
  | { result: "timeout" };

export type ServerReach =
  | { result: "ok"; status: number; cors: "allowed" | "missing" | "unknown" }
  | { result: "http"; status: number }
  | { result: "unreachable" }
  | { result: "timeout" }
  /** Our check couldn't run or refused the link (offline, private address, invalid). */
  | { result: "unavailable" };

export type Reachability = { browser: BrowserReach; server: ServerReach };

function timedOut(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

export async function browserReach(url: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<BrowserReach> {
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    void res.body?.cancel().catch(() => {});
    return res.ok ? { result: "readable", status: res.status } : { result: "http", status: res.status };
  } catch (e) {
    if (timedOut(e)) return { result: "timeout" };
  }
  // A CORS refusal and a failed connection throw the same TypeError. A no-cors request
  // tells them apart: it resolves (opaque) whenever the server answered at all.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    await fetch(url, { mode: "no-cors", credentials: "omit", cache: "no-store", signal: abort.signal });
    return { result: "answered" };
  } catch (e) {
    return timedOut(e) || abort.signal.aborted ? { result: "timeout" } : { result: "unreachable" };
  } finally {
    clearTimeout(timer);
    // The answer has arrived (or not); stop any body download.
    abort.abort();
  }
}

type Resolved = { ok: true; status: number; cors: "allowed" | "missing" | "unknown" } | { ok: false; reason: string; status?: number };

export async function serverReach(url: string): Promise<ServerReach> {
  try {
    const res = await fetch("/api/media/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      cache: "no-store",
    });
    if (!res.ok) return { result: "unavailable" };
    const r = (await res.json()) as Resolved;
    if (r.ok) return { result: "ok", status: r.status, cors: r.cors };
    if (r.reason === "http_error" && r.status) return { result: "http", status: r.status };
    if (r.reason === "timeout") return { result: "timeout" };
    if (r.reason === "unreachable") return { result: "unreachable" };
    return { result: "unavailable" };
  } catch {
    return { result: "unavailable" };
  }
}

export async function checkReachability(url: string): Promise<Reachability> {
  const [browser, server] = await Promise.all([browserReach(url), serverReach(url)]);
  return { browser, server };
}

/** Engine failures that might really be the network; the others are already specific. */
export function worthChecking(code: PlaybackErrorCode): boolean {
  return !["DRM_LICENSE_REQUIRED", "ENGINE_UNAVAILABLE", "NOT_MEDIA", "EXPIRED_OR_UNAUTHORIZED", "FINAL_CDN_CORS_BLOCKED"].includes(code);
}

const DECODE: PlaybackErrorCode[] = ["FORMAT_UNSUPPORTED", "VIDEO_UNSUPPORTED", "MSE_MANIFEST", "CODEC_UNSUPPORTED"];
const CORS: PlaybackErrorCode[] = ["RANGE_UNSUPPORTED", "FINAL_CDN_CORS_BLOCKED", "CORS_BLOCKED"];

/**
 * The code and sentence to show once the check is back. `message: null` keeps the
 * engine's own sentence. Only what was observed is claimed: no sentence names a
 * country, an ISP or a block, because a failed connection alone can't say why.
 */
export function verdict(code: PlaybackErrorCode, r: Reachability, host: string): { code: PlaybackErrorCode; message: string | null } {
  const { browser, server } = r;
  const fromServer = server.result === "ok" || server.result === "http";
  switch (browser.result) {
    case "http": {
      const s = browser.status;
      if (s === 401 || s === 403 || s === 451) {
        return {
          code: "HTTP_DENIED",
          message: `The video's server (${host}) refused this device (HTTP ${s}). The link may have expired, or that server may not allow this device.`,
        };
      }
      if (s === 404 || s === 410) return { code: "EXPIRED_OR_UNAUTHORIZED", message: `The video link wasn't found (HTTP ${s}). It may have expired.` };
      return { code: "SOURCE_UNAVAILABLE", message: `The video's server (${host}) answered this device with an error (HTTP ${s}).` };
    }
    case "unreachable":
    case "timeout": {
      const what = browser.result === "timeout" ? "didn't answer this device in time" : "couldn't be reached from this device";
      const c: PlaybackErrorCode = browser.result === "timeout" ? "NETWORK_TIMEOUT" : "NETWORK_UNREACHABLE";
      if (fromServer) {
        return {
          code: c,
          message: `The video's server (${host}) ${what}, but the same link answered Watch Party's server. The connection from this device's network to that server failed, so another network may work.`,
        };
      }
      if (server.result === "unreachable" || server.result === "timeout") {
        return { code: c, message: `Neither this device nor Watch Party's server could reach the video's server (${host}). It may be down, or the link may have expired.` };
      }
      return { code: c, message: `The video's server (${host}) ${what}. Check the connection and try again.` };
    }
    case "answered": {
      if (CORS.includes(code)) return { code, message: null };
      if (server.result === "ok" && server.cors === "allowed") {
        // Our server could read it with CORS; this device got an answer it can't read.
        return {
          code: "UNKNOWN",
          message: `The video's server (${host}) answered this device differently from Watch Party's server, which can read the same link. The browser doesn't say how, so the cause is unknown.`,
        };
      }
      if (DECODE.includes(code)) {
        return {
          code: "UNKNOWN",
          message: `The video's server (${host}) answered, but this browser couldn't play the video and doesn't say why. The format may not play on this device.`,
        };
      }
      return { code, message: null };
    }
    case "readable":
      // The bytes reach this page, so a decoder's complaint is about the video itself.
      if (DECODE.includes(code)) return { code: "CODEC_UNSUPPORTED", message: null };
      return { code, message: null };
  }
}

/** For the diagnostics report: outcomes and statuses only, never the URL. */
export function reachSummary(r: Reachability): { browser: string; server: string } {
  const say = (x: BrowserReach | ServerReach) =>
    "status" in x ? `${x.result} ${x.status}${"cors" in x ? ` cors:${x.cors}` : ""}` : x.result;
  return { browser: say(r.browser), server: say(r.server) };
}
