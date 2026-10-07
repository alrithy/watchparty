import type { PlaybackState } from "@/lib/room/types";

/** Below this, do nothing. */
export const DRIFT_IGNORE = 0.35;
/** Above this, hard seek. In between, nudge playbackRate. */
export const DRIFT_SEEK = 1.25;
/** Once correcting, keep going until drift falls under this (hysteresis). */
export const DRIFT_SETTLED = 0.1;
/** Minimum time between hard seeks so a slow network can't cause a seek loop. */
export const SEEK_COOLDOWN_MS = 2000;
/**
 * Players that can't nudge their rate (YouTube, some Vimeo accounts) correct by
 * seeking only, with a wider dead band and a longer cooldown because their
 * seeks rebuffer.
 */
export const DRIFT_SEEK_NO_RATE = 0.6;
export const SEEK_COOLDOWN_NO_RATE_MS = 3000;
/**
 * When the target is already buffered a seek is near-instant and exact, so
 * drift above this is fixed by seeking instead of a long rate nudge.
 */
export const DRIFT_SEEK_BUFFERED = 0.5;
export const MIN_RATE_DELTA = 0.02;
export const MAX_RATE_DELTA = 0.05;

/** Where the authoritative clock says the media should be right now. */
export function expectedPosition(
  state: PlaybackState,
  serverNow: number,
  duration?: number,
): number {
  let pos = state.positionSeconds;
  if (state.playing) pos += Math.max(0, serverNow - state.refTime) / 1000;
  if (duration && Number.isFinite(duration)) pos = Math.min(pos, duration);
  return Math.max(0, pos);
}

export type Correction =
  | { action: "none"; rate: 1 }
  | { action: "rate"; rate: number }
  | { action: "seek"; rate: 1 };

/**
 * Decide how to correct a playing follower.
 * @param drift local - expected, in seconds (positive = ahead of host)
 * @param correcting whether a rate correction is currently active
 * @param msSinceLastSeek time since this client last hard-seeked
 * @param canNudgeRate whether the player supports small playbackRate changes
 * @param targetBuffered whether the seek target is already buffered (a cheap, exact seek)
 */
export function decideCorrection(
  drift: number,
  correcting: boolean,
  msSinceLastSeek: number,
  canNudgeRate = true,
  targetBuffered = false,
): Correction {
  const abs = Math.abs(drift);
  if (targetBuffered && abs > DRIFT_SEEK_BUFFERED && msSinceLastSeek >= SEEK_COOLDOWN_MS) {
    return { action: "seek", rate: 1 };
  }
  if (!canNudgeRate) {
    return abs > DRIFT_SEEK_NO_RATE && msSinceLastSeek >= SEEK_COOLDOWN_NO_RATE_MS
      ? { action: "seek", rate: 1 }
      : { action: "none", rate: 1 };
  }
  if (abs > DRIFT_SEEK && msSinceLastSeek >= SEEK_COOLDOWN_MS) {
    return { action: "seek", rate: 1 };
  }
  if (abs >= DRIFT_IGNORE || (correcting && abs > DRIFT_SETTLED)) {
    const delta = Math.min(MAX_RATE_DELTA, Math.max(MIN_RATE_DELTA, abs * 0.04));
    // Ahead -> slow down, behind -> speed up.
    return { action: "rate", rate: drift > 0 ? 1 - delta : 1 + delta };
  }
  return { action: "none", rate: 1 };
}
