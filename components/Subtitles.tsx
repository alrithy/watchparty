"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { SubtitleTrack } from "@/lib/room/types";
import type { PlayerAdapter } from "@/lib/player/types";
import { activeCues, parseSubtitles, type Cue } from "@/lib/subtitles/parse";
import { unpackText } from "@/lib/subtitles/pack";
import { subtitleFromFile, subtitleFromUrl } from "@/lib/subtitles/load";

const TICK_MS = 100;

/**
 * Draws the room's subtitles over the player. Rendered by us rather than
 * through <track> so it also works over YouTube/Vimeo iframes and honours
 * the shared offset.
 */
export function SubtitleOverlay({
  track,
  playerRef,
  visible,
}: {
  track: SubtitleTrack | null;
  playerRef: RefObject<PlayerAdapter | null>;
  visible: boolean;
}) {
  // Keyed by track id so a new file never shows the previous file's cues.
  const [parsed, setParsed] = useState<{ id: string; cues: Cue[] } | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const id = track?.id;
  const data = track?.data;

  useEffect(() => {
    if (!id || !data) return;
    let cancelled = false;
    void unpackText(data)
      .then(parseSubtitles)
      .then(
        (cues) => !cancelled && setParsed({ id, cues }),
        () => !cancelled && setParsed({ id, cues: [] }),
      );
    return () => {
      cancelled = true;
    };
  }, [id, data]);

  const cues = parsed && parsed.id === id ? parsed.cues : null;
  const offset = track?.offset ?? 0;
  const lastRef = useRef("");
  useEffect(() => {
    if (!cues || !visible) return;
    const tick = () => {
      const p = playerRef.current;
      const next = p ? activeCues(cues, p.currentTime() - offset) : [];
      const key = next.join("\n\n");
      if (key !== lastRef.current) {
        lastRef.current = key;
        setLines(next);
      }
    };
    tick();
    const t = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(t);
      lastRef.current = "";
      setLines([]);
    };
  }, [cues, offset, playerRef, visible]);

  if (!cues || !visible || lines.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-[7%] z-10 flex flex-col items-center gap-1 px-4 text-center"
      data-testid="subtitle-text"
    >
      {lines.map((cue, i) => (
        <p
          key={i}
          dir="auto"
          className="max-w-[90%] whitespace-pre-line rounded bg-black/60 px-2 py-0.5 text-[clamp(14px,2.4vw,34px)] leading-snug text-white [unicode-bidi:plaintext]"
        >
          {cue}
        </p>
      ))}
    </div>
  );
}

/** Host: add (file or link), retime and remove. Everyone: show/hide locally. */
export function SubtitleControls({
  isHost,
  track,
  onChange,
  visible,
  onToggle,
}: {
  isHost: boolean;
  track: SubtitleTrack | null;
  onChange: (next: SubtitleTrack | null) => void;
  visible: boolean;
  onToggle: () => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (get: () => Promise<SubtitleTrack>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await get());
      setUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load those subtitles.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const shift = (delta: number) => {
    if (track) onChange({ ...track, offset: Math.round((track.offset + delta) * 10) / 10 });
  };
  const btn = "rounded border border-zinc-700 px-2.5 py-1 text-sm hover:border-zinc-400 disabled:opacity-50";

  return (
    <div className="space-y-2 text-sm text-zinc-300" data-testid="subtitles">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">Subtitles:</span>
        <span className="max-w-[16rem] truncate" data-testid="subtitle-name">
          {track ? track.name : "None"}
        </span>
        {track && (
          <>
            <button className={btn} onClick={onToggle} data-testid="subtitle-toggle">
              {visible ? "Hide" : "Show"}
            </button>
            <span className="text-zinc-500">Delay</span>
            {isHost && (
              <button className={btn} onClick={() => shift(-0.5)} aria-label="Subtitles earlier" data-testid="subtitle-earlier">
                −0.5s
              </button>
            )}
            <span className="font-mono" data-testid="subtitle-offset">
              {track.offset > 0 ? "+" : ""}
              {track.offset.toFixed(1)}s
            </span>
            {isHost && (
              <button className={btn} onClick={() => shift(0.5)} aria-label="Subtitles later" data-testid="subtitle-later">
                +0.5s
              </button>
            )}
            {isHost && (
              <button className={btn} onClick={() => onChange(null)} data-testid="subtitle-remove">
                Remove
              </button>
            )}
          </>
        )}
      </div>
      {isHost && (
        <div className="flex flex-wrap items-center gap-2">
          <label className={`${btn} cursor-pointer`}>
            {busy ? "Loading…" : "Upload .srt / .vtt"}
            <input
              ref={fileRef}
              type="file"
              accept=".srt,.vtt,text/vtt,application/x-subrip"
              className="sr-only"
              data-testid="subtitle-file"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void load(() => subtitleFromFile(file));
              }}
            />
          </label>
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (url.trim()) void load(() => subtitleFromUrl(url));
            }}
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="or paste a subtitle link"
              aria-label="Subtitle link"
              data-testid="subtitle-url"
              className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-400"
            />
            <button className={btn} disabled={busy || !url.trim()} data-testid="subtitle-load">
              Add
            </button>
          </form>
        </div>
      )}
      {error && <p className="text-red-300" data-testid="subtitle-error">{error}</p>}
    </div>
  );
}
