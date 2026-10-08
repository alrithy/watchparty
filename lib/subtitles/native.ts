import type { Cue } from "@/lib/subtitles/parse";

/**
 * Cues for a native <video> text track, for iPhone's own fullscreen player, which can't show our
 * overlay. The overlay shows a cue while `currentTime - offset` is inside it, so the native cue
 * is the same cue moved by `offset`. Cues that would end before the video starts are dropped.
 */
export function nativeCues(cues: Cue[], offset: number): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const end = c.end + offset;
    if (end <= 0) continue;
    out.push({ start: Math.max(0, c.start + offset), end, text: escapeCueText(c.text) });
  }
  return out;
}

/** Cue text is plain text; WebVTT would read `<` and `&` as markup. Bidi stays with the browser. */
export function escapeCueText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
