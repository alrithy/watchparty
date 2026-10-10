import { DRM_MESSAGE, INCOMPATIBLE_MESSAGE, NOT_DIRECT_MESSAGE, STREAM_START_TIMEOUT_MESSAGE } from "@/lib/media/source";
import { MOVI_TIMEOUT_MESSAGE, MOVI_UNKNOWN_MESSAGE } from "@/lib/player/movi";

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
  /** The provider never became ready, or the video's server didn't answer in time. */
  | "NETWORK_TIMEOUT"
  /** Safari's HLS player never reached metadata (no error, just no start). */
  | "STREAM_START_TIMEOUT"
  /** No answer reached this device (checked after the engines failed). */
  | "NETWORK_UNREACHABLE"
  /** This device saw the server refuse it: 401, 403 or 451. */
  | "HTTP_DENIED"
  /** The server answered with another error status (5xx, 429...). */
  | "SOURCE_UNAVAILABLE"
  /** The server answers this device but not readably from this page. */
  | "CORS_BLOCKED"
  /** Decoder failure while this device could read the bytes: the format itself. */
  | "CODEC_UNSUPPORTED"
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
  if (message === STREAM_START_TIMEOUT_MESSAGE) return "STREAM_START_TIMEOUT";
  if (message === MOVI_TIMEOUT_MESSAGE) return "NETWORK_TIMEOUT";
  if (message === MOVI_UNKNOWN_MESSAGE) return "UNKNOWN";
  if (/answered with an error \(http/.test(m)) return "SOURCE_UNAVAILABLE";
  if (message.startsWith(INCOMPATIBLE_MESSAGE)) return engine === "hlsjs" || engine === "dashjs" ? "MSE_MANIFEST" : "FORMAT_UNSUPPORTED";
  if (message === NOT_DIRECT_MESSAGE) return engine === "youtube" || engine === "vimeo" ? "NETWORK_TIMEOUT" : "NOT_MEDIA";
  return "UNKNOWN";
}

/** Failures no other engine can fix. (An expired link still gets its one retry: Movi's 403 can be a CORS preflight <video> never sends.) */
export function isTerminal(code: PlaybackErrorCode): boolean {
  return code === "DRM_LICENSE_REQUIRED";
}
