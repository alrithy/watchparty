import "server-only";
import { RD_API_BASE } from "@/lib/realdebrid/client";

export type RdVideo = { id: string; name: string; size: number | null };
export type HlsVariant = { quality: string; url: string };
export type RdCompatibility = {
  variants: HlsVariant[];
  durationSeconds: number | null;
  filename: string | null;
};

export type RdCompatErrorCode =
  | "INVALID_REQUEST" | "INVALID_TOKEN" | "ACCOUNT_RESTRICTED"
  | "RATE_LIMITED" | "RD_UNAVAILABLE" | "NO_HLS_VARIANT";
export class RdCompatError extends Error {
  constructor(readonly code: RdCompatErrorCode, readonly http: number, message: string) {
    super(message);
    this.name = "RdCompatError";
  }
}

export function validRdId(input: unknown): input is string {
  return typeof input === "string" && /^[a-zA-Z0-9_-]{4,100}$/.test(input);
}

function fromStatus(status: number, code?: number): RdCompatError {
  if (status === 401 || code === 8) return new RdCompatError("INVALID_TOKEN", 401, "Real-Debrid rejected this API key.");
  if (status === 403 || code === 22 || code === 14) return new RdCompatError("ACCOUNT_RESTRICTED", 403, "Real-Debrid refused access (account or IP restriction).");
  if (status === 429 || code === 34 || code === 5) return new RdCompatError("RATE_LIMITED", 429, "Real-Debrid is rate limiting requests. Try again later.");
  return new RdCompatError("RD_UNAVAILABLE", 502, "Real-Debrid could not return this information.");
}

/** Only RD's fixed API base is contacted. Never fetch a user-supplied URL. */
export async function rdRead(path: string, token: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${RD_API_BASE}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new RdCompatError("RD_UNAVAILABLE", 502, "Real-Debrid is unreachable.");
  }
  let body: unknown;
  try {
    const raw = await response.text();
    if (raw.length > 262_144) throw new Error("oversized response");
    body = JSON.parse(raw);
  } catch {
    throw new RdCompatError("RD_UNAVAILABLE", 502, "Real-Debrid returned an invalid response.");
  }
  if (!response.ok) {
    const code = body && typeof body === "object" && "error_code" in body
      ? Number((body as { error_code?: unknown }).error_code) : undefined;
    throw fromStatus(response.status, code);
  }
  return body;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** A download ID comes from RD's /downloads or /unrestrict/link; never guess it from a CDN URL. */
export function parseDownloads(raw: unknown): RdVideo[] {
  if (!Array.isArray(raw)) throw new RdCompatError("RD_UNAVAILABLE", 502, "Real-Debrid did not return a file list.");
  return raw.slice(0, 30).flatMap((item) => {
    const v = asRecord(item);
    if (!v || !validRdId(v.id) || typeof v.filename !== "string") return [];
    return [{ id: v.id, name: v.filename.slice(0, 200), size: typeof v.filesize === "number" && Number.isFinite(v.filesize) && v.filesize >= 0 ? v.filesize : null }];
  });
}

/** The API describes apple quality -> URL. Filter untrusted/malformed output, not just extension. */
export function parseAppleVariants(raw: unknown): HlsVariant[] {
  const apple = asRecord(asRecord(raw)?.apple);
  if (!apple) return [];
  const entries: HlsVariant[] = [];
  for (const [quality, candidate] of Object.entries(apple).slice(0, 24)) {
    if (!/^[a-zA-Z0-9_.-]{1,24}$/.test(quality) || typeof candidate !== "string" || candidate.length > 4096) continue;
    try {
      const u = new URL(candidate);
      if (u.protocol !== "https:" || u.username || u.password || !u.hostname || u.port) continue;
      entries.push({ quality, url: u.href });
    } catch { /* Invalid candidate from RD. */ }
  }
  return entries.sort((a, b) => {
    const qa = parseInt(a.quality, 10), qb = parseInt(b.quality, 10);
    return (Number.isFinite(qb) ? qb : -1) - (Number.isFinite(qa) ? qa : -1);
  });
}

function mediaMeta(raw: unknown): Pick<RdCompatibility, "durationSeconds" | "filename"> {
  const v = asRecord(raw);
  const d = v?.duration;
  return {
    durationSeconds: typeof d === "number" && Number.isFinite(d) && d > 0 && d < 86400 * 3 ? d : null,
    filename: typeof v?.filename === "string" ? v.filename.slice(0, 200) : null,
  };
}

/** Discovery for the account owner only. No credentials or URLs are returned in list mode. */
export async function listRdDownloads(token: string, fetchImpl: typeof fetch = fetch): Promise<RdVideo[]> {
  return parseDownloads(await rdRead("/downloads?limit=30", token, fetchImpl));
}

/** Probe official provider renditions; does NOT auto-switch the room or verify timeline identity. */
export async function getRdAppleVariants(id: string, token: string, fetchImpl: typeof fetch = fetch): Promise<RdCompatibility> {
  if (!validRdId(id)) throw new RdCompatError("INVALID_REQUEST", 400, "Invalid Real-Debrid download ID.");
  const raw = await rdRead(`/streaming/transcode/${encodeURIComponent(id)}`, token, fetchImpl);
  const variants = parseAppleVariants(raw);
  if (!variants.length) throw new RdCompatError("NO_HLS_VARIANT", 422, "Real-Debrid offers no Apple HLS version of this file.");
  // Metadata endpoint may return 503 even when a transcode exists. Don't discard the rendition.
  let meta: Pick<RdCompatibility, "durationSeconds" | "filename"> = { durationSeconds: null, filename: null };
  try { meta = mediaMeta(await rdRead(`/streaming/mediaInfos/${encodeURIComponent(id)}`, token, fetchImpl)); } catch { /* Report duration unknown. */ }
  return { variants, ...meta };
}

/** Guard for future in-room local-only fallback: missing duration never authorizes automatic sync. */
export function durationCompatible(expected: number, actual: number | null): boolean {
  if (!Number.isFinite(expected) || expected <= 0 || actual === null) return false;
  return Math.abs(expected - actual) <= Math.max(2, expected * 0.005);
}
