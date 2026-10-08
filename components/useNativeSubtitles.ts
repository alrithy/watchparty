"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { SubtitleTrack } from "@/lib/room/types";
import { findNativeVideo } from "@/lib/fullscreen";
import { parseSubtitles, type Cue } from "@/lib/subtitles/parse";
import { unpackText } from "@/lib/subtitles/pack";
import { nativeCues } from "@/lib/subtitles/native";

/** One text track per <video>: tracks can't be removed, only emptied and switched off. */
const tracks = new WeakMap<HTMLVideoElement, TextTrack>();

/** Turns the installed track on right before Apple's player opens, so it starts with captions. */
export function showNativeSubtitles(video: HTMLVideoElement) {
  const t = tracks.get(video);
  if (t && t.cues?.length) t.mode = "showing";
}

/**
 * Experiment (`?nativesubs=1`): the room's subtitles, with the shared delay, as a native text
 * track for iPhone's own fullscreen player, where our overlay can't be seen. The cues are
 * installed ahead of time, kept hidden, and only switched to showing while that player is open
 * (Safari may not draw a track added after it opened). Only for a real <video>; Movi draws on a
 * canvas.
 */
export function useNativeSubtitles(
  stageRef: RefObject<HTMLElement | null>,
  track: SubtitleTrack | null,
  install: boolean,
  showing: boolean,
) {
  const data = track?.data;
  const offset = track?.offset ?? 0;
  const showingRef = useRef(showing);

  useEffect(() => {
    showingRef.current = showing;
    const video = findNativeVideo(stageRef.current)?.video;
    const t = video && tracks.get(video);
    if (t && t.mode !== "disabled") t.mode = showing ? "showing" : "hidden";
  }, [showing, stageRef]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!install || !data || !stage) return;
    let cues: Cue[] | null = null;
    let current: { video: HTMLVideoElement; t: TextTrack } | null = null;
    const clear = () => {
      if (!current) return;
      const { t } = current;
      if (t.mode === "disabled") t.mode = "hidden";
      for (const c of Array.from(t.cues ?? [])) t.removeCue(c);
      t.mode = "disabled";
      current = null;
    };
    // Follows the current <video>: sources and decoders swap it.
    const apply = () => {
      const video = findNativeVideo(stage)?.video ?? null;
      if (!cues || video === (current?.video ?? null)) return;
      clear();
      if (!video) return;
      let t = tracks.get(video);
      if (!t) {
        t = video.addTextTrack("subtitles", "Subtitles", "ar");
        tracks.set(video, t);
      }
      t.mode = "hidden";
      for (const c of cues) t.addCue(new VTTCue(c.start, c.end, c.text));
      t.mode = showingRef.current ? "showing" : "hidden";
      current = { video, t };
    };
    let cancelled = false;
    void unpackText(data)
      .then(parseSubtitles)
      .then(
        (parsed) => {
          if (cancelled) return;
          cues = nativeCues(parsed, offset);
          apply();
        },
        () => {},
      );
    const watch = new MutationObserver(apply);
    watch.observe(stage, { childList: true, subtree: true });
    return () => {
      cancelled = true;
      watch.disconnect();
      clear();
    };
  }, [data, install, offset, stageRef]);
}
