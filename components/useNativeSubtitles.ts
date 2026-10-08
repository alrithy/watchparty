"use client";

import { useEffect, type RefObject } from "react";
import type { SubtitleTrack } from "@/lib/room/types";
import { findNativeVideo } from "@/lib/fullscreen";
import { parseSubtitles } from "@/lib/subtitles/parse";
import { unpackText } from "@/lib/subtitles/pack";
import { nativeCues } from "@/lib/subtitles/native";

/** One text track per <video>: tracks can't be removed, only emptied and switched off. */
const tracks = new WeakMap<HTMLVideoElement, TextTrack>();

/**
 * Experiment (`?nativesubs=1`): while iPhone's own video fullscreen is open, show the room's
 * subtitles, with the shared delay, as a native text track (our overlay can't be seen there).
 * Only for a real <video>; Movi draws on a canvas.
 */
export function useNativeSubtitles(stageRef: RefObject<HTMLElement | null>, track: SubtitleTrack | null, enabled: boolean) {
  const data = track?.data;
  const offset = track?.offset ?? 0;
  useEffect(() => {
    if (!enabled || !data) return;
    const video = findNativeVideo(stageRef.current)?.video;
    if (!video) return;
    let text = tracks.get(video);
    if (!text) {
      text = video.addTextTrack("subtitles", "Subtitles", "ar");
      tracks.set(video, text);
    }
    const t = text;
    let cancelled = false;
    void unpackText(data)
      .then(parseSubtitles)
      .then(
        (cues) => {
          if (cancelled) return;
          t.mode = "hidden";
          for (const c of nativeCues(cues, offset)) t.addCue(new VTTCue(c.start, c.end, c.text));
          t.mode = "showing";
        },
        () => {},
      );
    return () => {
      cancelled = true;
      if (t.mode === "disabled") t.mode = "hidden";
      for (const c of Array.from(t.cues ?? [])) t.removeCue(c);
      t.mode = "disabled";
    };
  }, [data, enabled, offset, stageRef]);
}
