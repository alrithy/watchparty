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
import { createPlayer } from "@/lib/player/create";
import type { PlayerAdapter, PlayerEvent } from "@/lib/player/types";
import { ServerClock } from "@/lib/sync/clock";
import { decideCorrection, expectedPosition } from "@/lib/sync/drift";

const HEARTBEAT_MS = 3000;
const DRIFT_TICK_MS = 250;
const SNAPSHOT_RETRY_MS = 3000;
const BUFFER_PAUSE_DELAY_MS = 1500;

type Options = {
  roomId: string;
  clientId: string;
  role: Role;
  /** Element the player adapter renders into. */
  stageRef: RefObject<HTMLDivElement | null>;
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

/** Same media in the room means the same player; anything else gets a fresh adapter. */
const mediaKey = (m: MediaSource | null) => (m ? `${m.kind}|${m.videoId ?? ""}|${m.url}` : "");

export function useWatchParty({ roomId, clientId, role, stageRef }: Options) {
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
  // Keyed by media so a new source starts without the previous source's error.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  const transportRef = useRef<RoomTransport | null>(null);
  const playerRef = useRef<PlayerAdapter | null>(null);
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
  const tryPlay = useCallback((p: PlayerAdapter, fromGesture = false) => {
    if (playPendingRef.current || (needsGestureRef.current && !fromGesture)) return;
    playPendingRef.current = true;
    p.play().then(
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
    const p = playerRef.current;
    if (!isHost || !p || !mediaRef.current) return;
    const now = clockRef.current.now();
    const prev = stateRef.current?.revision ?? 0;
    const next: PlaybackState = {
      playing: p.playing(),
      positionSeconds: p.currentTime(),
      refTime: now,
      // Time-based so it keeps increasing across host reloads.
      revision: Math.max(prev + 1, Math.floor(now)),
      hostId: clientId,
    };
    stateRef.current = next;
    setPlayback(next);
    persist();
    transportRef.current?.send("state", next);
  }, [clientId, isHost, persist]);

  const loadMedia = useCallback(
    (source: MediaSource) => {
      if (!isHost) return;
      restorePendingRef.current = false;
      mediaRef.current = source;
      setMedia(source);
      needsGestureRef.current = false;
      setNeedsGesture(false);
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
      if (mediaKey(snap.media) !== mediaKey(mediaRef.current)) {
        mediaRef.current = snap.media;
        setMedia(snap.media);
        needsGestureRef.current = false;
        setNeedsGesture(false);
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

  // ---------- Player lifecycle: one adapter per media; events drive status (everyone) + publishing (host) ----------
  const key = mediaKey(media);
  useEffect(() => {
    const stage = stageRef.current;
    const source = mediaRef.current;
    if (!stage || !source) {
      updateStatus("idle");
      return;
    }
    const p = createPlayer(source, stage, { controls: isHost });
    playerRef.current = p;
    playPendingRef.current = false;

    const onEvent = (e: PlayerEvent, detail?: { message?: string }) => {
      switch (e) {
        case "loading":
          updateStatus("loading");
          break;
        case "waiting":
          if (!p.canContinue()) updateStatus("buffering");
          break;
        case "canplay":
        case "playing":
        case "seeked":
          if (p.canContinue() && !p.error()) updateStatus("ready");
          break;
        case "ready":
          // Host reload: resume where the room should be.
          if (isHost && restorePendingRef.current && stateRef.current) {
            const s = stateRef.current;
            p.seek(expectedPosition(s, clockRef.current.now(), p.duration()));
            restorePendingRef.current = false;
            if (s.playing) tryPlay(p);
          }
          break;
        case "error":
          setFailure({ key, message: detail?.message ?? "Playback failed." });
          updateStatus("error");
          break;
      }
      if (isHost && !restorePendingRef.current && (e === "play" || e === "pause" || e === "seeked" || e === "playing")) {
        publishState();
      }
    };
    const off = p.on(onEvent);
    p.load(source);
    return () => {
      off();
      p.destroy();
      if (playerRef.current === p) playerRef.current = null;
    };
    // `key` identifies the media; the adapter must not be rebuilt for unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, isHost, stageRef]);

  // Debug/test handle: lets browser tests drive whichever player is active, including
  // cross-origin provider iframes. Exposes nothing the page doesn't already have.
  useEffect(() => {
    (window as unknown as { __watchparty?: unknown }).__watchparty = { player: () => playerRef.current };
  }, []);

  // Host heartbeat: re-anchor the reference so followers never extrapolate for long.
  useEffect(() => {
    if (!isHost) return;
    const t = setInterval(() => {
      const p = playerRef.current;
      if (p && p.playing() && p.canContinue()) publishState();
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [isHost, publishState]);

  // Host: optional pause-for-everyone while a guest buffers.
  const autoPausedRef = useRef(false);
  const someoneBuffering = participants.some((p) => p.role === "guest" && p.status === "buffering");
  useEffect(() => {
    if (!isHost || !settings.pauseOnBuffer) return;
    const p = playerRef.current;
    if (!p) return;
    if (someoneBuffering && p.playing()) {
      const t = setTimeout(() => {
        autoPausedRef.current = true;
        p.pause();
      }, BUFFER_PAUSE_DELAY_MS);
      return () => clearTimeout(t);
    }
    if (!someoneBuffering && autoPausedRef.current) {
      autoPausedRef.current = false;
      tryPlay(p);
    }
  }, [isHost, settings.pauseOnBuffer, someoneBuffering, tryPlay]);

  // Guest: drift correction loop against the authoritative clock, through the adapter only.
  useEffect(() => {
    if (isHost) return;
    let p: PlayerAdapter | null = null;
    let correcting = false;
    let canNudgeRate = true;
    let lastSeekAt = 0;
    let lastPresenceDrift: number | null = null;
    let lastPresenceAt = 0;

    const seekTo = (p: PlayerAdapter, target: number, now: number) => {
      p.setRate(1);
      p.seek(target);
      lastSeekAt = now;
      correcting = false;
    };

    const tick = () => {
      if (playerRef.current !== p) {
        // New source, new adapter: forget what we learned about the old one.
        p = playerRef.current;
        correcting = false;
        canNudgeRate = true;
        lastSeekAt = 0;
      }
      const s = stateRef.current;
      if (!p || !s || !mediaRef.current || !p.ready() || p.error()) return;
      const now = performance.now();
      const expected = expectedPosition(s, clockRef.current.now(), p.duration());
      const d = p.currentTime() - expected;

      if (!s.playing) {
        if (p.playing()) p.pause();
        p.setRate(1);
        correcting = false;
        // Seeks are cheap while paused, so match the host frame closely.
        if (Math.abs(d) > 0.1 && !p.seeking()) p.seek(expected);
      } else if (!p.playing()) {
        // Blocked by autoplay policy: wait for the click instead of seeking every tick.
        if (!needsGestureRef.current && !p.ended()) {
          if (Math.abs(d) > 0.15 && !p.seeking()) seekTo(p, expected + p.seekLead, now);
          tryPlay(p);
        }
      } else if (!p.seeking() && p.canContinue()) {
        const c = decideCorrection(d, correcting, now - lastSeekAt, canNudgeRate);
        if (c.action === "seek") {
          seekTo(p, expected + p.seekLead, now);
        } else if (p.setRate(c.rate)) {
          correcting = c.action === "rate";
        } else {
          // This player can't nudge its rate: correct by seeking from now on.
          canNudgeRate = false;
          correcting = false;
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
  }, [isHost, trackPresence, tryPlay]);

  const resumeWithGesture = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    needsGestureRef.current = false;
    setNeedsGesture(false);
    const s = stateRef.current;
    if (!s?.playing) return;
    p.seek(expectedPosition(s, clockRef.current.now(), p.duration()) + p.seekLead);
    tryPlay(p, true);
  }, [tryPlay]);

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
    mediaError: failure?.key === key ? failure.message : null,
    /** Current adapter, for local-only controls (volume, mute). */
    playerRef,
    hostPresent,
    loadMedia,
    updateSettings,
    updateStatus,
    resumeWithGesture,
  };
}
