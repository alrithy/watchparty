"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type {
  MediaSource,
  ParticipantStatus,
  PlaybackState,
  PresenceInfo,
  Role,
  RoomSettings,
  RoomSnapshot,
} from "@/lib/room/types";
import { createTransport, type ConnectionStatus, type RoomTransport } from "@/lib/realtime/transport";
import { ServerClock } from "@/lib/sync/clock";
import { decideCorrection, expectedPosition } from "@/lib/sync/drift";

const HEARTBEAT_MS = 3000;
const DRIFT_TICK_MS = 250;
const SNAPSHOT_RETRY_MS = 3000;
const BUFFER_PAUSE_DELAY_MS = 1500;
/** Seek slightly ahead to absorb the time the seek itself takes. */
const SEEK_LEAD_S = 0.1;

type Options = {
  roomId: string;
  clientId: string;
  role: Role;
  videoRef: RefObject<HTMLVideoElement | null>;
};

type HostSession = { media: MediaSource | null; state: PlaybackState | null; settings: RoomSettings };

const sessionKey = (roomId: string) => `watchparty:session:${roomId}`;

function loadHostSession(roomId: string): HostSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(roomId));
    return raw ? (JSON.parse(raw) as HostSession) : null;
  } catch {
    return null;
  }
}

function saveHostSession(roomId: string, s: HostSession) {
  try {
    sessionStorage.setItem(sessionKey(roomId), JSON.stringify(s));
  } catch {
    // Storage full or blocked: reload recovery just won't work.
  }
}

export function useWatchParty({ roomId, clientId, role, videoRef }: Options) {
  const isHost = role === "host";
  // RoomView only renders in the browser, so reading sessionStorage here is safe.
  const [restored] = useState(() => (isHost ? loadHostSession(roomId) : null));
  const [media, setMedia] = useState<MediaSource | null>(restored?.media ?? null);
  const [playback, setPlayback] = useState<PlaybackState | null>(restored?.state ?? null);
  const [settings, setSettings] = useState<RoomSettings>(restored?.settings ?? { pauseOnBuffer: false });
  const [participants, setParticipants] = useState<PresenceInfo[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [status, setStatus] = useState<ParticipantStatus>("idle");
  const [drift, setDrift] = useState<number | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [transportKind, setTransportKind] = useState<"supabase" | "local" | null>(null);

  const transportRef = useRef<RoomTransport | null>(null);
  const clockRef = useRef(new ServerClock());
  const stateRef = useRef<PlaybackState | null>(restored?.state ?? null);
  const mediaRef = useRef<MediaSource | null>(restored?.media ?? null);
  const settingsRef = useRef(settings);
  const gotSnapshotRef = useRef(false);
  const statusRef = useRef<ParticipantStatus>("idle");
  const driftRef = useRef<number | null>(null);
  // Host reload: seek/resume to the saved state once metadata is available.
  const restorePendingRef = useRef(Boolean(restored?.media && restored?.state));

  const persist = useCallback(() => {
    if (!isHost) return;
    saveHostSession(roomId, {
      media: mediaRef.current,
      state: stateRef.current,
      settings: settingsRef.current,
    });
  }, [isHost, roomId]);

  const trackPresence = useCallback(() => {
    transportRef.current?.track({
      clientId,
      role,
      status: statusRef.current,
      drift: driftRef.current === null ? null : Math.round(driftRef.current * 100) / 100,
    });
  }, [clientId, role]);

  const updateStatus = useCallback(
    (next: ParticipantStatus) => {
      if (statusRef.current === next) return;
      statusRef.current = next;
      setStatus(next);
      trackPresence();
    },
    [trackPresence],
  );

  const snapshot = useCallback(
    (): RoomSnapshot => ({
      media: mediaRef.current,
      state: stateRef.current,
      settings: settingsRef.current,
    }),
    [],
  );

  /** Try to play; browsers block unmuted autoplay until the user interacts. */
  const playPendingRef = useRef(false);
  const needsGestureRef = useRef(false);
  const tryPlay = useCallback((v: HTMLVideoElement, fromGesture = false) => {
    if (playPendingRef.current || (needsGestureRef.current && !fromGesture)) return;
    playPendingRef.current = true;
    v.play().then(
      () => {
        playPendingRef.current = false;
        needsGestureRef.current = false;
        setNeedsGesture(false);
      },
      (err: unknown) => {
        playPendingRef.current = false;
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          needsGestureRef.current = true;
          setNeedsGesture(true);
        }
      },
    );
  }, []);

  // ---------- Host: publish authoritative state from the local video ----------
  const publishState = useCallback(() => {
    const v = videoRef.current;
    if (!isHost || !v || !mediaRef.current) return;
    const now = clockRef.current.now();
    const prev = stateRef.current?.revision ?? 0;
    const next: PlaybackState = {
      playing: !v.paused && !v.ended,
      positionSeconds: v.currentTime,
      refTime: now,
      // Time-based so it keeps increasing across host reloads.
      revision: Math.max(prev + 1, Math.floor(now)),
      hostId: clientId,
    };
    stateRef.current = next;
    setPlayback(next);
    persist();
    transportRef.current?.send("state", next);
  }, [clientId, isHost, persist, videoRef]);

  const loadMedia = useCallback(
    (source: MediaSource) => {
      if (!isHost) return;
      restorePendingRef.current = false;
      mediaRef.current = source;
      setMedia(source);
      const now = clockRef.current.now();
      const next: PlaybackState = {
        playing: false,
        positionSeconds: 0,
        refTime: now,
        revision: Math.max((stateRef.current?.revision ?? 0) + 1, Math.floor(now)),
        hostId: clientId,
      };
      stateRef.current = next;
      setPlayback(next);
      persist();
      transportRef.current?.send("snapshot", snapshot());
    },
    [clientId, isHost, persist, snapshot],
  );

  const updateSettings = useCallback(
    (patch: Partial<RoomSettings>) => {
      if (!isHost) return;
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      persist();
      transportRef.current?.send("snapshot", snapshot());
    },
    [isHost, persist, snapshot],
  );

  // ---------- Guest: accept authoritative state ----------
  const acceptState = useCallback((next: PlaybackState | null) => {
    if (!next) return;
    const cur = stateRef.current;
    if (cur && next.revision < cur.revision) return; // stale/out-of-order
    stateRef.current = next;
    setPlayback(next);
  }, []);

  const acceptSnapshot = useCallback(
    (snap: RoomSnapshot) => {
      gotSnapshotRef.current = true;
      if (snap.media?.url !== mediaRef.current?.url) {
        mediaRef.current = snap.media;
        setMedia(snap.media);
        // New media: drop the old state regardless of revision.
        stateRef.current = null;
      }
      settingsRef.current = snap.settings;
      setSettings(snap.settings);
      acceptState(snap.state);
    },
    [acceptState],
  );

  // ---------- Connect: clock sync, then transport ----------
  useEffect(() => {
    let cancelled = false;
    const clock = clockRef.current;

    void clock.sync().then(() => {
      if (cancelled) return;
      const transport = createTransport(roomId, {
        onEvent: (event, payload) => {
          if (event === "snapshot_request" && isHost) {
            transportRef.current?.send("snapshot", snapshot());
          } else if (event === "snapshot" && !isHost) {
            acceptSnapshot(payload as RoomSnapshot);
          } else if (event === "state" && !isHost) {
            acceptState(payload as PlaybackState);
          }
        },
        onPresence: setParticipants,
        onStatus: (s) => {
          setConnection(s);
          if (s !== "connected") return;
          if (isHost) transportRef.current?.send("snapshot", snapshot());
          else {
            gotSnapshotRef.current = false;
            transportRef.current?.send("snapshot_request", { from: clientId });
          }
        },
      });
      transportRef.current = transport;
      setTransportKind(transport.kind);
      trackPresence();
    });

    // Periodic clock resync keeps offsets fresh on long sessions.
    const resync = setInterval(() => void clock.sync(3), 60_000);

    return () => {
      cancelled = true;
      clearInterval(resync);
      transportRef.current?.close();
      transportRef.current = null;
    };
  }, [acceptSnapshot, acceptState, clientId, isHost, roomId, snapshot, trackPresence]);

  // Guest: keep asking for a snapshot until the host answers (host may join later).
  useEffect(() => {
    if (isHost) return;
    const ask = () => {
      if (!gotSnapshotRef.current) transportRef.current?.send("snapshot_request", { from: clientId });
    };
    const t = setInterval(ask, SNAPSHOT_RETRY_MS);
    const onWake = () => {
      if (document.visibilityState === "visible") {
        gotSnapshotRef.current = false;
        ask();
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [clientId, isHost]);

  // Guest: when a host shows up in presence, ask again right away.
  const hostPresent = participants.some((p) => p.role === "host");
  useEffect(() => {
    if (!isHost && hostPresent && !gotSnapshotRef.current) {
      transportRef.current?.send("snapshot_request", { from: clientId });
    }
  }, [clientId, hostPresent, isHost]);

  // ---------- Video element events: status (everyone) + publishing (host) ----------
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onLoading = () => updateStatus("loading");
    const onBuffering = () => {
      if (v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) updateStatus("buffering");
    };
    const onReady = () => {
      if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) updateStatus("ready");
    };
    const onHostChange = () => {
      if (isHost && !restorePendingRef.current) publishState();
    };
    const onLoadedMetadata = () => {
      // Host reload: resume where the room should be.
      if (isHost && restorePendingRef.current && stateRef.current) {
        const s = stateRef.current;
        v.currentTime = expectedPosition(s, clockRef.current.now(), v.duration);
        restorePendingRef.current = false;
        if (s.playing) tryPlay(v);
      }
    };

    v.addEventListener("loadstart", onLoading);
    v.addEventListener("waiting", onBuffering);
    v.addEventListener("stalled", onBuffering);
    v.addEventListener("canplay", onReady);
    v.addEventListener("playing", onReady);
    v.addEventListener("seeked", onReady);
    v.addEventListener("loadedmetadata", onLoadedMetadata);
    const hostEvents = ["play", "pause", "seeked", "playing"] as const;
    for (const e of hostEvents) v.addEventListener(e, onHostChange);
    return () => {
      v.removeEventListener("loadstart", onLoading);
      v.removeEventListener("waiting", onBuffering);
      v.removeEventListener("stalled", onBuffering);
      v.removeEventListener("canplay", onReady);
      v.removeEventListener("playing", onReady);
      v.removeEventListener("seeked", onReady);
      v.removeEventListener("loadedmetadata", onLoadedMetadata);
      for (const e of hostEvents) v.removeEventListener(e, onHostChange);
    };
  }, [isHost, publishState, tryPlay, updateStatus, videoRef]);

  // Host heartbeat: re-anchor the reference so followers never extrapolate for long.
  useEffect(() => {
    if (!isHost) return;
    const t = setInterval(() => {
      const v = videoRef.current;
      if (v && !v.paused && v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) publishState();
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [isHost, publishState, videoRef]);

  // Host: optional pause-for-everyone while a guest buffers.
  const autoPausedRef = useRef(false);
  const someoneBuffering = participants.some((p) => p.role === "guest" && p.status === "buffering");
  useEffect(() => {
    if (!isHost || !settings.pauseOnBuffer) return;
    const v = videoRef.current;
    if (!v) return;
    if (someoneBuffering && !v.paused) {
      const t = setTimeout(() => {
        autoPausedRef.current = true;
        v.pause();
      }, BUFFER_PAUSE_DELAY_MS);
      return () => clearTimeout(t);
    }
    if (!someoneBuffering && autoPausedRef.current) {
      autoPausedRef.current = false;
      tryPlay(v);
    }
  }, [isHost, settings.pauseOnBuffer, someoneBuffering, tryPlay, videoRef]);

  // Guest: drift correction loop against the authoritative clock.
  useEffect(() => {
    if (isHost) return;
    let correcting = false;
    let lastSeekAt = 0;
    let lastPresenceDrift: number | null = null;
    let lastPresenceAt = 0;

    const tick = () => {
      const v = videoRef.current;
      const s = stateRef.current;
      if (!v || !s || !mediaRef.current || v.readyState < HTMLMediaElement.HAVE_METADATA || v.error) return;
      const now = performance.now();
      const expected = expectedPosition(s, clockRef.current.now(), v.duration);
      const d = v.currentTime - expected;

      if (!s.playing) {
        if (!v.paused) v.pause();
        v.playbackRate = 1;
        correcting = false;
        // Seeks are cheap while paused, so match the host frame closely.
        if (Math.abs(d) > 0.1 && !v.seeking) v.currentTime = expected;
      } else if (v.paused) {
        // Blocked by autoplay policy: wait for the click instead of seeking every tick.
        if (!needsGestureRef.current && !v.ended) {
          if (Math.abs(d) > 0.15 && !v.seeking) {
            v.currentTime = expected + SEEK_LEAD_S;
            lastSeekAt = now;
          }
          tryPlay(v);
        }
      } else if (!v.seeking && v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        const c = decideCorrection(d, correcting, now - lastSeekAt);
        if (c.action === "seek") {
          v.playbackRate = 1;
          v.currentTime = expected + SEEK_LEAD_S;
          lastSeekAt = now;
          correcting = false;
        } else {
          if (v.playbackRate !== c.rate) v.playbackRate = c.rate;
          correcting = c.action === "rate";
        }
      }

      driftRef.current = d;
      setDrift(d);
      // Share drift with the host occasionally, not every tick.
      if (now - lastPresenceAt > 3000 && (lastPresenceDrift === null || Math.abs(d - lastPresenceDrift) > 0.05)) {
        lastPresenceAt = now;
        lastPresenceDrift = d;
        trackPresence();
      }
    };
    const t = setInterval(tick, DRIFT_TICK_MS);
    return () => clearInterval(t);
  }, [isHost, trackPresence, tryPlay, videoRef]);

  const resumeWithGesture = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    needsGestureRef.current = false;
    setNeedsGesture(false);
    const s = stateRef.current;
    if (!s?.playing) return;
    v.currentTime = expectedPosition(s, clockRef.current.now(), v.duration) + SEEK_LEAD_S;
    tryPlay(v, true);
  }, [tryPlay, videoRef]);

  return {
    media,
    playback,
    settings,
    participants,
    connection,
    status,
    drift,
    needsGesture,
    transportKind,
    hostPresent,
    loadMedia,
    updateSettings,
    updateStatus,
    resumeWithGesture,
  };
}
