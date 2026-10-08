import { moviErrorMessage } from "@/lib/player/movi";

/** Internal reason when the file's final server itself refuses cross-origin reads. */
export const FINAL_CDN_CORS_BLOCKED = "FINAL_CDN_CORS_BLOCKED";

/** Where the CORS Unlocker extension marks the page it runs on (see extensions/cors-unlocker). */
const UNLOCKER_FLAG = "watchpartyCorsUnlocker";
const PROBE_TIMEOUT_MS = 8000;

export type Refinement =
  /** Retry Movi on this URL (the end of the redirect chain, readable from this page). */
  | { url: string }
  /** Don't retry; tell the viewer this. */
  | { message: string; reason?: typeof FINAL_CDN_CORS_BLOCKED };

type Resolved =
  | { ok: true; finalUrl: string; redirected: boolean }
  | { ok: false; reason: string; status?: number };

export function corsUnlockerInstalled(): boolean {
  return typeof document !== "undefined" && !!document.documentElement.dataset[UNLOCKER_FLAG];
}

export function finalCdnBlockedMessage(host: string, unlocker: boolean): string {
  return unlocker
    ? `The video's server (${host}) blocks browser streaming, and the CORS Unlocker extension doesn't cover it yet. Add this host to the extension.`
    : `The video's server (${host}) blocks browser streaming of this format. On desktop Chrome, Edge or Brave, the WatchParty CORS Unlocker extension fixes this; phone browsers can't play this link.`;
}

/** Whether this page may read `url` cross-origin with a Range request, as Movi does. */
export async function browserCanRead(url: string): Promise<"ok" | "blocked" | "error"> {
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => {});
    return res.ok ? "ok" : "error";
  } catch (e) {
    // A CORS refusal surfaces as a TypeError with no response.
    return e instanceof TypeError ? "blocked" : "error";
  }
}

async function resolveOnServer(url: string): Promise<Resolved | null> {
  try {
    const res = await fetch("/api/media/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as Resolved;
  } catch {
    return null;
  }
}

/**
 * After Movi was refused byte-range access: follow the redirect chain on the
 * server (headers only), then check from this page whether the final URL can be
 * read. Redirect hops without CORS are skipped this way; a final server without
 * CORS can't be fixed from a web page. Returns null when there's nothing better to say.
 */
export async function refineStreamUrl(url: string): Promise<Refinement | null> {
  const resolved = await resolveOnServer(url);
  if (!resolved) return null;
  if (!resolved.ok) {
    if (resolved.status === 404 || resolved.status === 410) return { message: moviErrorMessage("missing") };
    if (resolved.status === 401 || resolved.status === 403) return { message: moviErrorMessage("denied") };
    return null;
  }
  const readable = await browserCanRead(resolved.finalUrl);
  if (readable === "ok") return { url: resolved.finalUrl };
  if (readable === "blocked") {
    let host = "unknown host";
    try {
      host = new URL(resolved.finalUrl).hostname;
    } catch {}
    return { message: finalCdnBlockedMessage(host, corsUnlockerInstalled()), reason: FINAL_CDN_CORS_BLOCKED };
  }
  return null;
}
