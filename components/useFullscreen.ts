"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { findNativeVideo, lockScroll, pickFullscreenMode } from "@/lib/fullscreen";
import { showNativeSubtitles } from "@/components/useNativeSubtitles";

type WebkitDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };

type Options = {
  /** The player box: player + subtitle overlay. */
  screenRef: RefObject<HTMLElement | null>;
  /** Where the adapter renders its <video>. */
  stageRef: RefObject<HTMLElement | null>;
  exitRef: RefObject<HTMLButtonElement | null>;
  /**
   * Experiment (`?nativesubs=1`): on iPhone use Apple's own video fullscreen, with the subtitles
   * mirrored into a native text track, instead of the app's immersive mode.
   */
  nativeVideoFullscreen: boolean;
};

/**
 * Fullscreen for the player box. Uses the Fullscreen API where the browser offers it for elements;
 * otherwise (iPhone) switches to the app's immersive mode, which pins the box over the page, locks
 * page scroll, hides the <video>'s own controls (their fullscreen button opens Apple's player,
 * which drops our subtitles) and exits on Escape or the exit button. If Apple's player opens
 * anyway, it is closed again and immersive mode takes over.
 */
export function useFullscreen({ screenRef, stageRef, exitRef, nativeVideoFullscreen }: Options) {
  const [immersive, setImmersive] = useState(false);
  const [native, setNative] = useState(false);
  const [nativeVideo, setNativeVideo] = useState(false);

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

  // Follows the current <video> (sources and decoders swap it) to watch Apple's fullscreen
  // and, while immersive, keep its own controls off.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let current: ReturnType<typeof findNativeVideo> = null;
    let detach = () => {};
    const attach = () => {
      const found = findNativeVideo(stage);
      if (found?.video === current?.video && found?.owner === current?.owner) return;
      detach();
      current = found;
      if (!found) return;
      const { owner, video } = found;
      const controls = owner.controls;
      if (immersive) owner.controls = false;
      const begin = () => {
        if (nativeVideoFullscreen) return setNativeVideo(true);
        video.webkitExitFullscreen?.();
        setImmersive(true);
      };
      const end = () => setNativeVideo(false);
      video.addEventListener("webkitbeginfullscreen", begin);
      video.addEventListener("webkitendfullscreen", end);
      detach = () => {
        video.removeEventListener("webkitbeginfullscreen", begin);
        video.removeEventListener("webkitendfullscreen", end);
        owner.controls = controls;
        current = null;
      };
    };
    attach();
    const watch = new MutationObserver(attach);
    watch.observe(stage, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      detach();
    };
  }, [immersive, nativeVideoFullscreen, stageRef]);

  const toggle = useCallback(() => {
    const el = screenRef.current as WebkitElement | null;
    if (!el) return;
    if (immersive) return setImmersive(false);
    const doc = document as WebkitDocument;
    if (doc.fullscreenElement) return void doc.exitFullscreen().catch(() => {});
    if (doc.webkitFullscreenElement) return doc.webkitExitFullscreen?.();
    const mode = pickFullscreenMode(el, doc);
    if (mode === "standard") return void el.requestFullscreen().catch(() => setImmersive(true));
    if (mode === "webkit") return el.webkitRequestFullscreen?.();
    const video = nativeVideoFullscreen ? findNativeVideo(stageRef.current)?.video : null;
    if (video?.webkitEnterFullscreen) {
      showNativeSubtitles(video);
      video.webkitEnterFullscreen();
    }
    else setImmersive(true);
  }, [immersive, nativeVideoFullscreen, screenRef, stageRef]);

  const exit = useCallback(() => setImmersive(false), []);

  return { immersive, nativeVideo, active: immersive || native || nativeVideo, toggle, exit };
}
