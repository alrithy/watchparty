import { DRM_MESSAGE, INCOMPATIBLE_MESSAGE, NOT_DIRECT_MESSAGE, STREAM_START_TIMEOUT_MESSAGE } from "@/lib/media/source";

/**
 * Why a playback attempt failed, as a stable code for diagnostics and tests.
 * Viewers still see the sentence; the code says which step broke.
 */
export type PlaybackErrorCode =
  /** 401/403/404/410 or a signed link that expired. */
  | "EXPIRED_OR_UNAUTHORIZED"
  /** The server (or a redirect hop) refused cross-origin byte-range reads. */
  | "RANGE_UNSUPPORTED"
  /** The final CDN sends no CORS headers; no web page can read it. */
  | "FINAL_CDN_CORS_BLOCKED"
  /** Container or codecs this engine can't decode. */
  | "FORMAT_UNSUPPORTED"
  /** Audio plays but there is no picture. */
  | "VIDEO_UNSUPPORTED"
  /** hls.js / dash.js couldn't use the manifest or its segments. */
  | "MSE_MANIFEST"
  | "NETWORK_ERROR"
  /** The provider never became ready. */
  | "NETWORK_TIMEOUT"
  | "DRM_LICENSE_REQUIRED"
  /** A web page, not a media file. */
  | "NOT_MEDIA"
  /** No engine for this source exists on this device (e.g. DASH without MSE). */
  | "ENGINE_UNAVAILABLE"
  | "UNKNOWN";

/** Our own failure sentences → codes. Engine matters: hls.js and <video> share sentences. */
export function classifyFailure(engine: string, message: string, reason?: string | null): PlaybackErrorCode {
  if (reason === "FINAL_CDN_CORS_BLOCKED") return "FINAL_CDN_CORS_BLOCKED";
  const m = message.toLowerCase();
  if (message === DRM_MESSAGE) return "DRM_LICENSE_REQUIRED";
  if (/blocks browser (byte-range access|streaming)/.test(m)) return message.includes("server (") ? "FINAL_CDN_CORS_BLOCKED" : "RANGE_UNSUPPORTED";
  if (/wasn't found|refused access|expired/.test(m)) return "EXPIRED_OR_UNAUTHORIZED";
  if (/no playable video track/.test(m)) return "VIDEO_UNSUPPORTED";
  if (/couldn't load the|not available on this device|can't play .* streams/.test(m)) return "ENGINE_UNAVAILABLE";
  if (m.startsWith("network error")) return "NETWORK_ERROR";
  if (message === STREAM_START_TIMEOUT_MESSAGE) return "NETWORK_TIMEOUT";
  if (message.startsWith(INCOMPATIBLE_MESSAGE)) return engine === "hlsjs" || engine === "dashjs" ? "MSE_MANIFEST" : "FORMAT_UNSUPPORTED";
  if (message === NOT_DIRECT_MESSAGE) return engine === "youtube" || engine === "vimeo" ? "NETWORK_TIMEOUT" : "NOT_MEDIA";
  return "UNKNOWN";
}

/** Failures no other engine can fix. (An expired link still gets its one retry: Movi's 403 can be a CORS preflight <video> never sends.) */
export function isTerminal(code: PlaybackErrorCode): boolean {
  return code === "DRM_LICENSE_REQUIRED";
}
