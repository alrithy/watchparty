import type { SubtitleTrack } from "@/lib/room/types";
import { decodeSubtitleBytes, parseSubtitles } from "@/lib/subtitles/parse";
import { MAX_PACKED_BYTES, packText } from "@/lib/subtitles/pack";

const MAX_FILE_BYTES = 2_000_000;

async function toTrack(bytes: ArrayBuffer, name: string): Promise<SubtitleTrack> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("That file is too large for subtitles.");
  const text = decodeSubtitleBytes(bytes);
  await parseSubtitles(text); // validates; guests parse their own copy
  const data = await packText(text);
  if (data.length > MAX_PACKED_BYTES) throw new Error("That subtitle file is too large to share.");
  return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, name, data, offset: 0 };
}

export function subtitleFromBytes(bytes: ArrayBuffer, name: string): Promise<SubtitleTrack> {
  return toTrack(bytes, name);
}

export async function subtitleFromFile(file: File): Promise<SubtitleTrack> {
  return toTrack(await file.arrayBuffer(), file.name);
}

/** Fetches in the browser; if the host blocks that (CORS), our server fetches the text instead. */
export async function subtitleFromUrl(input: string): Promise<SubtitleTrack> {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new Error("That link isn't valid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("That link isn't valid.");
  const name = decodeURIComponent(url.pathname.split("/").pop() || url.hostname);
  let bytes: ArrayBuffer | null = null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) bytes = await res.arrayBuffer();
  } catch {
    // Blocked by CORS or offline; try through the server.
  }
  if (!bytes) {
    const res = await fetch("/api/subtitles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.toString() }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? "Couldn't load those subtitles.");
    }
    bytes = await res.arrayBuffer();
  }
  return toTrack(bytes, name);
}
