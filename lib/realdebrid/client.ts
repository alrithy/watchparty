import "server-only";
import type { RdErrorBody } from "@/lib/realdebrid/types";

export const RD_API_BASE = "https://api.real-debrid.com/rest/1.0";
const TIMEOUT_MS = 15_000;

export type RdResponse = { status: number; body: unknown };

/** Real-Debrid answered with an error status, or could not be reached (status 0). */
export class RealDebridError extends Error {
  constructor(
    readonly status: number,
    readonly body: RdErrorBody,
  ) {
    super(`Real-Debrid error ${status}${body.error_code !== undefined ? ` (code ${body.error_code})` : ""}`);
    this.name = "RealDebridError";
  }
}

/**
 * The host's token, read on the server only. Never prefix it with NEXT_PUBLIC_;
 * the `server-only` import above makes a client import fail the build.
 */
export function hostToken(): string | null {
  return process.env.REAL_DEBRID_TOKEN?.trim() || null;
}

/**
 * Form-encoded POST to the REST API with the token in the Authorization
 * header (never as the `auth_token` query parameter, so it can't end up in a URL).
 */
export async function rdPost(
  path: string,
  form: Record<string, string>,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RdResponse> {
  let res: Response;
  try {
    res = await fetchImpl(`${RD_API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new RealDebridError(0, { error: "unreachable" });
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body && typeof body === "object" ? body : {}) as RdErrorBody;
    throw new RealDebridError(res.status, err);
  }
  return { status: res.status, body };
}
