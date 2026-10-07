/**
 * Real-Debrid REST API 1.0 shapes (https://api.real-debrid.com/) and the
 * app-level result of resolving a host link. Nothing here carries a token.
 */

/** `POST /unrestrict/link` success body for a single generated link. */
export type RdUnrestrictedLink = {
  id: string;
  filename: string;
  /** Guessed from the file extension. */
  mimeType?: string;
  /** Bytes, 0 if unknown. */
  filesize?: number;
  /** Original hoster link. */
  link?: string;
  /** Hoster main domain. */
  host?: string;
  chunks?: number;
  crc?: number;
  /** Generated (unrestricted) download link. */
  download: string;
  streamable?: number;
  type?: string;
  alternative?: { id: string; filename: string; download: string; type?: string }[];
};

/** Error body: `{ "error": "bad_token", "error_code": 8 }`. */
export type RdErrorBody = { error?: string; error_code?: number };

/** Numeric `error_code` values from the API docs that we act on. */
export const RD_ERROR = {
  INTERNAL: -1,
  MISSING_PARAMETER: 1,
  BAD_PARAMETER: 2,
  SLOW_DOWN: 5,
  UNREACHABLE: 6,
  NOT_FOUND: 7,
  BAD_TOKEN: 8,
  PERMISSION_DENIED: 9,
  ACCOUNT_LOCKED: 14,
  ACCOUNT_NOT_ACTIVATED: 15,
  UNSUPPORTED_HOSTER: 16,
  HOSTER_MAINTENANCE: 17,
  HOSTER_LIMIT: 18,
  HOSTER_UNAVAILABLE: 19,
  HOSTER_PREMIUM_ONLY: 20,
  TOO_MANY_DOWNLOADS: 21,
  IP_NOT_ALLOWED: 22,
  TRAFFIC_EXHAUSTED: 23,
  FILE_UNAVAILABLE: 24,
  SERVICE_UNAVAILABLE: 25,
  TOO_MANY_REQUESTS: 34,
  INFRINGING_FILE: 35,
  FAIR_USAGE_LIMIT: 36,
  DISABLED_ENDPOINT: 37,
} as const;

/** What the browser receives: just enough to play and label the file. */
export type ResolvedMedia = {
  url: string;
  filename: string;
  mimeType: string | null;
  filesize: number | null;
};

export type HostRdErrorCode =
  | "not_configured"
  | "invalid_link"
  | "invalid_token"
  | "account_locked"
  | "unsupported_host"
  | "link_unavailable"
  | "hoster_unavailable"
  | "ip_not_allowed"
  | "traffic_exhausted"
  | "rate_limited"
  | "upstream_error";

export type HostRdError = {
  code: HostRdErrorCode;
  /** Safe, user-facing explanation. */
  message: string;
  /** HTTP status our route answers with. */
  status: number;
  /** Real-Debrid's numeric code, for logs. */
  rdCode?: number;
};

export type ResolveResult =
  | { ok: true; media: ResolvedMedia; remote: boolean }
  | { ok: false; error: HostRdError };
