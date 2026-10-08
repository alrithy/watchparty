"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { lockScroll, pickFullscreenMode } from "@/lib/fullscreen";

type WebkitDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };

/**
 * Fullscreen for the player box (player + subtitle overlay). Uses the Fullscreen API where the
 * browser offers it for elements; otherwise (iPhone) switches to the app's immersive mode, which
 * pins the box over the page, locks page scroll and exits on Escape or the exit button.
 */
export function useFullscreen(screenRef: RefObject<HTMLElement | null>, exitRef: RefObject<HTMLButtonElement | null>) {
  const [immersive, setImmersive] = useState(false);
  const [native, setNative] = useState(false);

  useEffect(() => {
    const sync = () => {
      const doc = document as WebkitDocument;
      const el = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setNative(el !== null && el === screenRef.current);
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [screenRef]);

  useEffect(() => {
    if (!immersive) return;
    const returnFocus = document.activeElement as HTMLElement | null;
    const unlock = lockScroll(document, window);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImmersive(false);
    };
    document.addEventListener("keydown", onKey);
    exitRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      unlock();
      returnFocus?.focus?.({ preventScroll: true });
    };
  }, [immersive, exitRef]);

  const toggle = useCallback(() => {
    const el = screenRef.current as WebkitElement | null;
    if (!el) return;
    if (immersive) return setImmersive(false);
    const doc = document as WebkitDocument;
    if (doc.fullscreenElement) return void doc.exitFullscreen().catch(() => {});
    if (doc.webkitFullscreenElement) return doc.webkitExitFullscreen?.();
    const mode = pickFullscreenMode(el, doc);
    if (mode === "standard") void el.requestFullscreen().catch(() => setImmersive(true));
    else if (mode === "webkit") el.webkitRequestFullscreen?.();
    else setImmersive(true);
  }, [immersive, screenRef]);

  const exit = useCallback(() => setImmersive(false), []);

  return { immersive, active: immersive || native, toggle, exit };
}
