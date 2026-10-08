"use client";

import { useEffect, useState, type RefObject } from "react";
import type { PlayerAdapter } from "@/lib/player/types";

const POLL_MS = 500;

/**
 * Width/height of the playing picture while `active`, or null when unknown (iframe players, before
 * metadata). Polled, because the player and its picture can change underneath (new source,
 * decoder switch, adaptive streams changing resolution).
 */
export function usePictureAspect(playerRef: RefObject<PlayerAdapter | null>, active: boolean): number | null {
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const read = () => {
      const size = playerRef.current?.videoSize?.();
      const next = size ? size.width / size.height : null;
      setAspect((prev) => (prev !== null && next !== null && Math.abs(prev - next) < 0.001 ? prev : next));
    };
    const first = setTimeout(read, 0);
    const timer = setInterval(read, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active, playerRef]);
  return active ? aspect : null;
}
