import SrtParser from "srt-parser-2";

export type Cue = { start: number; end: number; text: string };

const VTT_HEADER = /^﻿?WEBVTT/;

/** Strips markup subtitle files carry (<i>, <v Bob>, {\an8}) and decodes the common entities. */
export function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** SRT through srt-parser-2. */
export function parseSrt(text: string): Cue[] {
  return new SrtParser()
    .fromSrt(text.replace(/^﻿/, "").replace(/\r\n?/g, "\n"))
    .map((c) => ({ start: c.startSeconds, end: c.endSeconds, text: cleanCueText(c.text) }))
    .filter((c) => c.text && c.end > c.start);
}

/** WebVTT through the browser's own parser (an offscreen <track>). */
export function parseVtt(text: string): Promise<Cue[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const track = document.createElement("track");
    const url = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
    const done = (fn: () => void) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error("Couldn't read the subtitles."))), 5000);
    track.onload = () =>
      done(() =>
        resolve(
          Array.from(track.track.cues ?? [])
            .map((c) => ({ start: c.startTime, end: c.endTime, text: cleanCueText((c as VTTCue).text) }))
            .filter((c) => c.text),
        ),
      );
    track.onerror = () => done(() => reject(new Error("Couldn't read the subtitles.")));
    track.src = url;
    video.appendChild(track);
    track.track.mode = "hidden";
  });
}

/** Detects the format from the content (not the file name) and parses it. */
export async function parseSubtitles(text: string): Promise<Cue[]> {
  const cues = VTT_HEADER.test(text) ? await parseVtt(text) : parseSrt(text);
  if (cues.length === 0) throw new Error("No subtitles found in that file. Use .srt or .vtt.");
  return cues.sort((a, b) => a.start - b.start);
}

/** Lines showing at media time `t`. */
export function activeCues(cues: Cue[], t: number): string[] {
  const out: string[] = [];
  for (const c of cues) {
    if (c.start > t) break;
    if (t < c.end) out.push(c.text);
  }
  return out;
}

/**
 * Subtitle files are often not UTF-8 (Arabic SRTs are frequently Windows-1256).
 * Try strict UTF-8 first, then the legacy Arabic code page.
 */
export function decodeSubtitleBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1256").decode(bytes);
  }
}
