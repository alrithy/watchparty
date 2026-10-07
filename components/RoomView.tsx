"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import type { PlaybackMode, PresenceInfo, Role } from "@/lib/room/types";
import { useWatchParty } from "@/components/useWatchParty";
import {
  INCOMPATIBLE_MESSAGE,
  describeMediaError,
  isHls,
  makeHostRdSource,
  makeSource,
  resolveHostRd,
  validateMediaUrl,
} from "@/lib/media/source";

type Props = { roomId: string; clientId: string; role: Role };

export default function RoomView({ roomId, clientId, role }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const isHost = role === "host";
  const room = useWatchParty({ roomId, clientId, role, videoRef });
  const [mediaError, setMediaError] = useState<string | null>(null);
  const { media, updateStatus } = room;

  // Attach the source: native playback first, hls.js only where HLS isn't native.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setMediaError(null);
    if (!media) {
      v.removeAttribute("src");
      v.load();
      return;
    }
    let cancelled = false;
    let destroy: (() => void) | undefined;
    if (isHls(media.url) && !v.canPlayType("application/vnd.apple.mpegurl")) {
      void import("hls.js").then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          setMediaError(INCOMPATIBLE_MESSAGE);
          return;
        }
        const hls = new Hls();
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          setMediaError(
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? "Network error while loading the stream."
              : INCOMPATIBLE_MESSAGE,
          );
          updateStatus("error");
        });
        hls.loadSource(media.url);
        hls.attachMedia(v);
        destroy = () => hls.destroy();
      });
    } else {
      v.src = media.url;
      v.load();
    }
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [media, updateStatus]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onError = () => {
      setMediaError(describeMediaError(v.error));
      updateStatus("error");
    };
    // Some codecs (e.g. HEVC in Chrome) load audio but no picture.
    const onMeta = () => {
      if (v.videoWidth === 0 && v.videoHeight === 0) {
        setMediaError(`${INCOMPATIBLE_MESSAGE} No playable video track was found.`);
      }
    };
    v.addEventListener("error", onError);
    v.addEventListener("loadedmetadata", onMeta);
    return () => {
      v.removeEventListener("error", onError);
      v.removeEventListener("loadedmetadata", onMeta);
    };
  }, [updateStatus]);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-lg font-semibold tracking-wide text-zinc-100">
          Watch Party
        </Link>
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <span>
            Room <span className="font-mono text-zinc-100" data-testid="room-id">{roomId}</span>
          </span>
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs uppercase">{role}</span>
          <ConnectionBadge status={room.connection} kind={room.transportKind} />
        </div>
      </header>

      {room.transportKind === "local" && (
        <p className="rounded border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          Supabase is not configured, so sync only works between tabs of this browser.
        </p>
      )}

      <div ref={stageRef} className="relative overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          data-testid="video"
          className="aspect-video w-full bg-black"
          controls={isHost}
          playsInline
          preload="auto"
        />
        {!media && (
          <Overlay>{isHost ? "Choose a source below to start." : "Waiting for the host to pick something to watch…"}</Overlay>
        )}
        {mediaError && (
          <Overlay>
            <p className="text-red-300" data-testid="media-error">{mediaError}</p>
          </Overlay>
        )}
        {room.needsGesture && !mediaError && (
          <Overlay>
            <button
              data-testid="join-playback"
              onClick={room.resumeWithGesture}
              className="rounded-md bg-zinc-100 px-5 py-3 font-medium text-zinc-900 hover:bg-white"
            >
              Click to join playback
            </button>
          </Overlay>
        )}
      </div>

      {!isHost && <GuestControls videoRef={videoRef} stageRef={stageRef} />}

      <section className="grid gap-4 md:grid-cols-3">
        <Panel title="Participants">
          <ul className="space-y-1 text-sm" data-testid="participants">
            {room.participants.length === 0 && <li className="text-zinc-500">Connecting…</li>}
            {room.participants.map((p) => (
              <ParticipantRow key={p.clientId} p={p} self={p.clientId === clientId} />
            ))}
          </ul>
        </Panel>

        <Panel title="Sync">
          <dl className="space-y-1 text-sm">
            <Row label="State" value={room.playback ? (room.playback.playing ? "Playing" : "Paused") : "—"} testId="sync-state" />
            <Row label="You" value={statusLabel(room.status)} />
            {!isHost && (
              <Row
                label="Drift"
                value={room.drift === null ? "—" : `${room.drift >= 0 ? "+" : ""}${room.drift.toFixed(2)}s`}
                testId="drift"
              />
            )}
            {!isHost && !room.hostPresent && <p className="text-amber-300">Host is not connected.</p>}
          </dl>
          {isHost && (
            <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={room.settings.pauseOnBuffer}
                onChange={(e) => room.updateSettings({ pauseOnBuffer: e.target.checked })}
              />
              Pause when a participant buffers
            </label>
          )}
        </Panel>

        <Panel title="Invite">
          <InviteLink roomId={roomId} />
        </Panel>
      </section>

      <Panel title="Playback source">
        {isHost ? (
          <SourceForm onLoad={room.loadMedia} />
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input type="radio" name="guest-source" defaultChecked /> Use host stream
              </label>
              <label className="flex items-center gap-2 text-zinc-500" title="Coming in a later milestone">
                <input type="radio" name="guest-source" disabled /> Use my Real-Debrid (soon)
              </label>
            </div>
          </div>
        )}
        <p className="mt-2 truncate text-sm text-zinc-400" data-testid="media-label">
          {media ? `Now: ${media.label}` : "Nothing loaded."}
        </p>
      </Panel>
    </main>
  );
}

function SourceForm({ onLoad }: { onLoad: ReturnType<typeof useWatchParty>["loadMedia"] }) {
  const [mode, setMode] = useState<PlaybackMode>("direct");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (resolving) return;
    const err = validateMediaUrl(url);
    setError(err);
    if (err) return;
    if (mode === "direct") {
      onLoad(makeSource("direct", url));
      return;
    }
    setResolving(true);
    const result = await resolveHostRd(url);
    setResolving(false);
    if ("error" in result) setError(result.error);
    else onLoad(makeHostRdSource(result.media));
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name="mode" checked={mode === "direct"} onChange={() => setMode("direct")} /> Direct URL
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="mode"
            data-testid="mode-host-rd"
            checked={mode === "host-rd"}
            onChange={() => setMode("host-rd")}
          />{" "}
          Host Real-Debrid
        </label>
      </div>
      <div className="flex gap-2">
        <input
          data-testid="source-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={mode === "direct" ? "https://example.com/movie.mp4 or .m3u8" : "Hoster link to resolve with Real-Debrid"}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-400"
        />
        <button
          data-testid="load-source"
          disabled={resolving}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
        >
          {resolving ? "Resolving…" : "Load"}
        </button>
      </div>
      {error && <p className="text-sm text-red-300" data-testid="source-error">{error}</p>}
    </form>
  );
}

function GuestControls({
  videoRef,
  stageRef,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  return (
    <div className="flex items-center gap-3 text-sm text-zinc-300">
      <button
        className="rounded border border-zinc-700 px-3 py-1 hover:border-zinc-400"
        onClick={() => {
          const v = videoRef.current;
          if (!v) return;
          v.muted = !v.muted;
          setMuted(v.muted);
        }}
      >
        {muted ? "Unmute" : "Mute"}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        aria-label="Volume"
        onChange={(e) => {
          const v = videoRef.current;
          const next = Number(e.target.value);
          if (v) v.volume = next;
          setVolume(next);
        }}
      />
      <button
        className="rounded border border-zinc-700 px-3 py-1 hover:border-zinc-400"
        onClick={() => void stageRef.current?.requestFullscreen?.()}
      >
        Fullscreen
      </button>
      <span className="text-zinc-500">The host controls playback.</span>
    </div>
  );
}

function InviteLink({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false);
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );
  const link = `${origin}/room/${roomId}`;
  return (
    <div className="space-y-2">
      <p className="truncate font-mono text-xs text-zinc-400" data-testid="invite-link">{link}</p>
      <button
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-400"
        onClick={() => {
          void navigator.clipboard?.writeText(link).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy invite link"}
      </button>
    </div>
  );
}

function ParticipantRow({ p, self }: { p: PresenceInfo; self: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2" data-testid={`participant-${p.role}`}>
      <span className="text-zinc-300">
        {p.role === "host" ? "Host" : "Guest"}
        {self && <span className="text-zinc-500"> (you)</span>}
      </span>
      <span className={statusColor(p.status)}>
        {statusLabel(p.status)}
        {p.role === "guest" && p.drift !== null && (
          <span className="ml-2 font-mono text-xs text-zinc-500">{p.drift >= 0 ? "+" : ""}{p.drift.toFixed(2)}s</span>
        )}
      </span>
    </li>
  );
}

function ConnectionBadge({ status, kind }: { status: string; kind: string | null }) {
  const color = status === "connected" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-500" : "bg-red-500";
  return (
    <span className="flex items-center gap-1.5" data-testid="connection" data-status={status}>
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {status}
      {kind === "local" && " (local)"}
    </span>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="font-mono text-zinc-200" data-testid={testId}>{value}</dd>
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6 text-center text-zinc-300">
      {children}
    </div>
  );
}

function statusLabel(s: PresenceInfo["status"]): string {
  return { idle: "Idle", loading: "Loading", ready: "Ready", buffering: "Buffering", error: "Error" }[s];
}

function statusColor(s: PresenceInfo["status"]): string {
  return {
    idle: "text-zinc-500",
    loading: "text-amber-300",
    ready: "text-emerald-400",
    buffering: "text-amber-300",
    error: "text-red-400",
  }[s];
}

const noopSubscribe = () => () => {};
