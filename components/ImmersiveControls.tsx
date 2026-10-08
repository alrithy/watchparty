"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PictureFit, PlayerAdapter } from "@/lib/player/types";

const TICK_MS = 250;
/** How long the controls stay up after a tap while playing. */
const HIDE_MS = 3000;

/**
 * Controls inside the app's iPhone fullscreen, where the <video>'s own controls are off. The host
 * gets play/pause and seek (they go through the player, so the room follows as it does for the
 * native controls); everyone gets mute, and volume where the page can set it (not on iPhone,
 * where only the side buttons change the level).
 */
export function ImmersiveControls({
  isHost,
  playerRef,
  areaRef,
  muted,
  volume,
  onMuted,
  onVolume,
  fit,
  onFit,
}: {
  isHost: boolean;
  playerRef: RefObject<PlayerAdapter | null>;
  /** Taps anywhere here bring the controls back. */
  areaRef: RefObject<HTMLElement | null>;
  muted: boolean;
  volume: number;
  onMuted: (muted: boolean) => void;
  onVolume: (volume: number) => void;
  fit: PictureFit;
  onFit: (fit: PictureFit) => void;
}) {
  const [now, setNow] = useState({ t: 0, d: NaN, playing: false });
  const [dragging, setDragging] = useState<number | null>(null);
  const [visible, setVisible] = useState(true);
  const [volumeWorks] = useState(canSetVolume);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Shown on any tap or focus; fade out while playing, stay while paused.
  const poke = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    const later = () => {
      hideTimer.current = setTimeout(() => {
        if (playerRef.current?.playing()) setVisible(false);
        else later();
      }, HIDE_MS);
    };
    later();
  }, [playerRef]);

  useEffect(() => {
    const area = areaRef.current;
    const start = setTimeout(poke, 0);
    area?.addEventListener("pointerdown", poke);
    return () => {
      clearTimeout(start);
      clearTimeout(hideTimer.current);
      area?.removeEventListener("pointerdown", poke);
    };
  }, [areaRef, poke]);

  useEffect(() => {
    const tick = () => {
      const p = playerRef.current;
      setNow(p ? { t: p.currentTime(), d: p.duration(), playing: p.playing() } : { t: 0, d: NaN, playing: false });
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [playerRef]);

  const known = Number.isFinite(now.d);
  const shown = dragging ?? now.t;
  const btn =
    "flex h-11 min-w-11 items-center justify-center rounded-full px-3 ring-1 ring-white/30 focus-visible:outline-2 focus-visible:outline-white";

  return (
    <div
      role="toolbar"
      aria-label="Player controls"
      data-testid="immersive-controls"
      data-visible={visible || undefined}
      onFocus={poke}
      className={`immersive-controls absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 bg-gradient-to-t from-black/85 to-transparent pt-8 text-sm text-white transition-opacity duration-200 ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      {isHost && (
        <>
          <button
            type="button"
            className={btn}
            data-testid="immersive-play"
            aria-label={now.playing ? "Pause" : "Play"}
            onClick={() => {
              const p = playerRef.current;
              if (!p) return;
              if (p.playing()) p.pause();
              else void p.play().catch(() => {});
            }}
          >
            <span aria-hidden="true">{now.playing ? "❚❚" : "▶"}</span>
          </button>
          <input
            type="range"
            min={0}
            max={known ? now.d : 0}
            step={0.1}
            value={Math.min(shown, known ? now.d : 0)}
            disabled={!known}
            aria-label="Seek"
            aria-valuetext={`${clock(shown)} of ${known ? clock(now.d) : "unknown"}`}
            data-testid="immersive-seek"
            className="min-w-0 flex-1"
            onChange={(e) => setDragging(Number(e.target.value))}
            onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onBlur={() => dragging !== null && commit(dragging)}
          />
        </>
      )}
      <span className={`tabular-nums text-xs text-zinc-300 ${isHost ? "" : "flex-1"}`} data-testid="immersive-time">
        {clock(shown)} / {known ? clock(now.d) : "--:--"}
      </span>
      <button
        type="button"
        className={btn}
        data-testid="immersive-mute"
        aria-label={muted ? "Unmute" : "Mute"}
        aria-pressed={muted}
        onClick={() => onMuted(!muted)}
      >
        <span aria-hidden="true">{muted ? "🔇" : "🔊"}</span>
      </button>
      <button
        type="button"
        className={btn}
        data-testid="immersive-fit"
        aria-label={fit === "cover" ? "Fit whole picture" : "Fill screen"}
        aria-pressed={fit === "cover"}
        onClick={() => onFit(fit === "cover" ? "contain" : "cover")}
      >
        {fit === "cover" ? "Fit" : "Fill"}
      </button>
      {volumeWorks && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          aria-label="Volume"
          data-testid="immersive-volume"
          className="w-20"
          onChange={(e) => onVolume(Number(e.target.value))}
        />
      )}
    </div>
  );

  function commit(seconds: number) {
    setDragging(null);
    if (Number.isFinite(seconds) && Math.abs(seconds - now.t) > 0.05) playerRef.current?.seek(seconds);
  }
}

function clock(s: number) {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** iOS keeps media volume at 1 whatever the page sets (the hardware buttons own it). */
function canSetVolume() {
  const probe = document.createElement("audio");
  probe.volume = 0.5;
  return probe.volume !== 1;
}
