import { RealDebridError, rdPost } from "@/lib/realdebrid/client";
import {
  RD_ERROR,
  type HostRdError,
  type RdErrorBody,
  type RdUnrestrictedLink,
  type ResolvedMedia,
  type ResolveResult,
} from "@/lib/realdebrid/types";

const MAX_LINK_LENGTH = 2048;

const err = (code: HostRdError["code"], status: number, message: string, rdCode?: number): HostRdError => ({
  code,
  status,
  message,
  rdCode,
});

/** Validates the pasted host link. Returns an error or null. */
export function validateHostLink(input: unknown): HostRdError | null {
  if (typeof input !== "string" || !input.trim()) {
    return err("invalid_link", 400, "Paste a hoster link to resolve.");
  }
  const link = input.trim();
  if (link.length > MAX_LINK_LENGTH) return err("invalid_link", 400, "That link is too long.");
  if (/^magnet:/i.test(link)) {
    return err("unsupported_host", 422, "Magnet and torrent links aren't supported yet. Paste a hoster link.");
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return err("invalid_link", 400, "Enter a full link starting with http:// or https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return err("invalid_link", 400, "Only http(s) links are supported.");
  }
  return null;
}

/** Hostname only, for logs: generated links and hoster links can act as credentials. */
export function redactUrl(input: string): string {
  try {
    return `${new URL(input).hostname}/…`;
  } catch {
    return "invalid-url";
  }
}

/**
 * Picks the playable link out of a `/unrestrict/link` body. The API returns an
 * object for one file and an array when it generates several (e.g. qualities).
 */
export function parseUnrestrictResponse(body: unknown): ResolvedMedia | null {
  const item = (Array.isArray(body) ? body[0] : body) as Partial<RdUnrestrictedLink> | null | undefined;
  if (!item || typeof item !== "object" || typeof item.download !== "string") return null;
  let url: URL;
  try {
    url = new URL(item.download);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Pages are served over https, so an http media URL would be blocked as mixed content.
  url.protocol = "https:";
  const filename = typeof item.filename === "string" && item.filename ? item.filename : "media";
  return {
    url: url.toString(),
    filename,
    mimeType: typeof item.mimeType === "string" && item.mimeType ? item.mimeType : null,
    filesize: typeof item.filesize === "number" && item.filesize > 0 ? item.filesize : null,
  };
}

/** Maps a Real-Debrid failure to a user-facing error, by numeric code first, then HTTP status. */
export function mapRdError(status: number, body: RdErrorBody): HostRdError {
  const c = body.error_code;
  switch (c) {
    case RD_ERROR.BAD_TOKEN:
      return err("invalid_token", 502, "The host's Real-Debrid token is invalid or expired.", c);
    case RD_ERROR.ACCOUNT_LOCKED:
    case RD_ERROR.ACCOUNT_NOT_ACTIVATED:
    case RD_ERROR.PERMISSION_DENIED:
      return err("account_locked", 502, "The host's Real-Debrid account is locked or not allowed to do this.", c);
    case RD_ERROR.HOSTER_PREMIUM_ONLY:
      return err("account_locked", 502, "This hoster needs a premium Real-Debrid account.", c);
    case RD_ERROR.UNSUPPORTED_HOSTER:
      return err("unsupported_host", 422, "Real-Debrid doesn't support this hoster.", c);
    case RD_ERROR.MISSING_PARAMETER:
    case RD_ERROR.BAD_PARAMETER:
      return err("invalid_link", 400, "Real-Debrid rejected this link.", c);
    case RD_ERROR.NOT_FOUND:
    case RD_ERROR.FILE_UNAVAILABLE:
    case RD_ERROR.INFRINGING_FILE:
      return err("link_unavailable", 422, "This link is dead, expired or unavailable.", c);
    case RD_ERROR.UNREACHABLE:
    case RD_ERROR.HOSTER_MAINTENANCE:
    case RD_ERROR.HOSTER_LIMIT:
    case RD_ERROR.HOSTER_UNAVAILABLE:
    case RD_ERROR.TOO_MANY_DOWNLOADS:
    case RD_ERROR.SERVICE_UNAVAILABLE:
      return err("hoster_unavailable", 503, "The hoster is temporarily unavailable through Real-Debrid. Try again later.", c);
    case RD_ERROR.IP_NOT_ALLOWED:
      return err(
        "ip_not_allowed",
        502,
        "Real-Debrid refused the request because of an IP address restriction. Remote traffic may be unavailable on the host's account.",
        c,
      );
    case RD_ERROR.TRAFFIC_EXHAUSTED:
    case RD_ERROR.FAIR_USAGE_LIMIT:
      return err("traffic_exhausted", 502, "The host's Real-Debrid traffic is exhausted.", c);
    case RD_ERROR.SLOW_DOWN:
    case RD_ERROR.TOO_MANY_REQUESTS:
      return err("rate_limited", 429, "Too many Real-Debrid requests. Wait a minute and try again.", c);
  }
  if (status === 0) return err("upstream_error", 502, "Couldn't reach Real-Debrid. Try again.");
  if (status === 401) return err("invalid_token", 502, "The host's Real-Debrid token is invalid or expired.", c);
  if (status === 403) return err("account_locked", 502, "The host's Real-Debrid account is locked.", c);
  if (status === 429) return err("rate_limited", 429, "Too many Real-Debrid requests. Wait a minute and try again.", c);
  if (status === 503) return err("link_unavailable", 422, "Real-Debrid couldn't generate a link (dead link or hoster limit).", c);
  return err("upstream_error", 502, "Real-Debrid returned an unexpected error.", c);
}

type ResolveOptions = { token: string; fetchImpl?: typeof fetch };

/**
 * Unrestricts a hoster link with the host's account.
 *
 * Real-Debrid applies IP protections: requests from dedicated servers (Vercel
 * runs on cloud IPs) and links used from several IPs can be refused with
 * `error_code` 22. `remote=1` uses the account's Remote traffic, which lifts
 * those protections, so we retry with it only when the plain request is refused.
 */
export async function resolveHostLink(link: string, { token, fetchImpl }: ResolveOptions): Promise<ResolveResult> {
  const invalid = validateHostLink(link);
  if (invalid) return { ok: false, error: invalid };

  const attempt = async (remote: boolean) => {
    const form: Record<string, string> = { link: link.trim() };
    if (remote) form.remote = "1";
    return rdPost("/unrestrict/link", form, token, fetchImpl);
  };

  let remote = false;
  let res;
  try {
    res = await attempt(false);
  } catch (e) {
    if (!(e instanceof RealDebridError)) throw e;
    if (e.body.error_code !== RD_ERROR.IP_NOT_ALLOWED) return { ok: false, error: mapRdError(e.status, e.body) };
    remote = true;
    try {
      res = await attempt(true);
    } catch (e2) {
      if (!(e2 instanceof RealDebridError)) throw e2;
      return { ok: false, error: mapRdError(e2.status, e2.body) };
    }
  }

  const media = parseUnrestrictResponse(res.body);
  if (!media) return { ok: false, error: err("upstream_error", 502, "Real-Debrid returned no playable link.") };
  return { ok: true, media, remote };
}
