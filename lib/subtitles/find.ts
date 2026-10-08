import type { MediaSource, SubtitleTrack } from "@/lib/room/types";
import type { SearchResult } from "@/lib/subtitles/search";
import type { Ranked } from "@/lib/subtitles/search/score";
import { subtitleFromBytes } from "@/lib/subtitles/load";

export type FoundSubtitles = SearchResult & { needTitle: boolean };
export type SubtitleChoice = Ranked;

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

/** Asks our server to search the subtitle providers for this video (Arabic by default). */
export async function findArabicSubtitles(media: MediaSource, title?: string): Promise<FoundSubtitles> {
  const res = await fetch("/api/subtitles/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: media.kind, url: media.url, videoId: media.videoId, title: title || undefined }),
  });
  if (!res.ok) throw await errorOf(res, "Subtitle search failed.");
  return (await res.json()) as FoundSubtitles;
}

/** Downloads one search result through our server and turns it into a shareable track. */
export async function subtitleFromChoice(choice: SubtitleChoice): Promise<SubtitleTrack> {
  const res = await fetch("/api/subtitles/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: choice.provider, id: choice.id }),
  });
  if (!res.ok) throw await errorOf(res, "Couldn't download that subtitle.");
  return subtitleFromBytes(await res.arrayBuffer(), choice.release || "Arabic subtitles");
}
