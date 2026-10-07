"use client";

import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import type { PresenceInfo, Role } from "@/lib/room/types";
import type { PlayerAdapter } from "@/lib/player/types";
import { useWatchParty } from "@/components/useWatchParty";
import { prepareSource } from "@/lib/media/prepare";
import { SubtitleControls, SubtitleOverlay } from "@/components/Subtitles";

type Props = { roomId: string; clientId: string; role: Role };

export default function RoomView({ roomId, clientId, role }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  // Fullscreen takes the player and the subtitle layer together.
  const screenRef = useRef<HTMLDivElement>(null);
  const isHost = role === "host";
  const room = useWatchParty({ roomId, clientId, role, stageRef });
  const { media, mediaError } = room;
  const [showSubtitles, setShowSubtitles] = useState(true);

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

      <div
        ref={screenRef}
        data-testid="screen"
        className="relative overflow-hidden rounded-lg bg-black [&:fullscreen]:flex [&:fullscreen]:items-center [&:fullscreen]:rounded-none"
      >
        {/* The player adapter renders its <video> or provider iframe in here. */}
        <div ref={stageRef} data-testid="stage" data-kind={media?.kind ?? ""} className="w-full" />
        <SubtitleOverlay track={room.subtitles} playerRef={room.playerRef} visible={showSubtitles} />
        {!media && <div className="aspect-video w-full" />}
        {!media && (
          <Overlay>{isHost ? "Paste a link below to start." : "Waiting for the host to pick something to watch…"}</Overlay>
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

      <PlayerBar isHost={isHost} playerRef={room.playerRef} screenRef={screenRef} />

      <Panel title="Watch">
        {isHost && <SourceForm onLoad={room.loadMedia} />}
        <p className="mt-2 truncate text-sm text-zinc-400" data-testid="media-label">
          {media ? `Now: ${media.label}` : "Nothing loaded."}
        </p>
        {media && (isHost || room.subtitles) && (
          <div className="mt-3 border-t border-zinc-800 pt-3">
            <SubtitleControls
              key={media.url}
              media={media}
              isHost={isHost}
              track={room.subtitles}
              onChange={room.setSubtitles}
              visible={showSubtitles}
              onToggle={() => setShowSubtitles((v) => !v)}
            />
          </div>
        )}
      </Panel>

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

    </main>
  );
}

function SourceForm({ onLoad }: { onLoad: ReturnType<typeof useWatchParty>["loadMedia"] }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await prepareSource(url);
    setBusy(false);
    if ("error" in result) setError(result.error);
    else onLoad(result.source);
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <input
          data-testid="source-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste anything to watch"
          aria-label="Paste anything to watch"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-400"
        />
        <button
          data-testid="load-source"
          disabled={busy}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
        >
          {busy ? "Checking…" : "Play"}
        </button>
      </div>
      {error && <p className="text-sm text-red-300" data-testid="source-error">{error}</p>}
    </form>
  );
}

/** Local controls under the player: guests get volume (the host uses the player's own), everyone gets fullscreen. */
function PlayerBar({
  isHost,
  playerRef,
  screenRef,
}: {
  isHost: boolean;
  playerRef: React.RefObject<PlayerAdapter | null>;
  screenRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const btn = "rounded border border-zinc-700 px-3 py-1 hover:border-zinc-400";
  const fullscreen = () => {
    const el = screenRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el.requestFullscreen) void el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else {
      // iPhone Safari only lets the <video> itself go fullscreen (our subtitle layer can't follow).
      const v = el.querySelector("video") as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
      v?.webkitEnterFullscreen?.();
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
      {!isHost && (
        <>
          <button
            className={btn}
            onClick={() => {
              playerRef.current?.setMuted(!muted);
              setMuted(!muted);
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
              const next = Number(e.target.value);
              playerRef.current?.setVolume(next);
              setVolume(next);
            }}
          />
        </>
      )}
      <button className={btn} onClick={fullscreen} data-testid="fullscreen">
        Fullscreen
      </button>
      {!isHost && <span className="text-zinc-500">The host controls playback.</span>}
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
          // Phones get the share sheet (Messages, WhatsApp...); desktops copy the link.
          if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
            void navigator.share({ title: "Watch Party", url: link }).catch(() => {});
            return;
          }
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
