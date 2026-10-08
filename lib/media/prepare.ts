import type { MediaSource } from "@/lib/room/types";
import { NOT_DIRECT_MESSAGE, resolveSource } from "@/lib/media/source";

type ProbeResponse =
  | { result: "playable"; kind: MediaSource["kind"]; filename?: string; contentType?: string }
  | { result: "not_media" }
  | { result: "unknown" };

/**
 * Turns whatever the host pasted into a room source. The URL decides when it
 * can; otherwise the server peeks at the headers. If the probe can't tell, the
 * HTML5 player gets a try and reports its own error.
 */
export async function prepareSource(input: string): Promise<{ source: MediaSource } | { error: string }> {
  const resolved = resolveSource(input);
  if (!resolved.ok) return { error: resolved.error };
  if (resolved.certain) return { source: resolved.source };
  try {
    const res = await fetch("/api/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: resolved.source.url }),
    });
    if (!res.ok) return { source: resolved.source };
    const probe = (await res.json()) as ProbeResponse;
    if (probe.result === "not_media") return { error: NOT_DIRECT_MESSAGE };
    if (probe.result === "playable") {
      const host = new URL(resolved.source.url).hostname;
      return {
        source: {
          ...resolved.source,
          kind: probe.kind,
          ...(probe.filename ? { label: `${probe.filename} (${host})` } : {}),
          ...(probe.contentType ? { mime: probe.contentType } : {}),
        },
      };
    }
  } catch {
    // Probe unavailable: let the browser try.
  }
  return { source: resolved.source };
}
