import type { MediaSource } from "@/lib/room/types";
import type { Capabilities } from "@/lib/media/capabilities";
import type { Engine, PlaybackPlan, Routing } from "@/lib/media/route";
import type { PlaybackErrorCode } from "@/lib/media/errors";
import type { MediaInfoSummary } from "@/lib/player/types";

/**
 * What happened when this device tried to play the current source: the plan,
 * each engine attempt, and the device's capabilities. It stays in this tab
 * (shown in the room, copied by the viewer) and never holds a URL path, query
 * string, token or file name: only host names and the file extension.
 */

export type Attempt = {
  engine: Engine;
  /** ms after the report started. */
  startedMs: number;
  readyMs?: number;
  playingMs?: number;
  outcome: "pending" | "ready" | "playing" | "failed" | "replaced";
  code?: PlaybackErrorCode;
  message?: string;
  media?: MediaInfoSummary;
  /** Set when the redirect resolver ran for this attempt. */
  resolved?: { finalHost: string; retried: boolean };
};

export type PlaybackReport = {
  routing: Routing;
  source: { kind: MediaSource["kind"]; host: string; extension: string | null; mime: string | null };
  plan: { engines: Engine[]; reasons: string[] };
  attempts: Attempt[];
  capabilities: Capabilities;
};

/** Host name only: paths and query strings often carry signed tokens or API keys. */
export function safeHost(url: string): string {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

/** The extension of the last path segment, if it looks like one; never the name itself. */
export function safeExtension(url: string, label?: string): string | null {
  const ext = (s: string) => /\.([a-z0-9]{2,5})$/i.exec(s)?.[1]?.toLowerCase() ?? null;
  try {
    const fromPath = ext(new URL(url).pathname);
    if (fromPath) return fromPath;
  } catch {}
  return label ? ext(label.replace(/\s+\([^)]*\)$/, "")) : null;
}

type Listener = () => void;

class DiagnosticsStore {
  /** Mutable working copy; `published` is the immutable snapshot readers get. */
  private draft: PlaybackReport | null = null;
  private published: PlaybackReport | null = null;
  private id = 0;
  private started = 0;
  private listeners = new Set<Listener>();

  begin(source: MediaSource, plan: PlaybackPlan, capabilities: Capabilities, routing: Routing): DiagnosticsSession {
    this.id++;
    this.started = performance.now();
    this.draft = {
      routing,
      source: {
        kind: source.kind,
        host: safeHost(source.url),
        extension: source.kind === "youtube" || source.kind === "vimeo" ? null : safeExtension(source.url, source.label),
        mime: source.mime ?? null,
      },
      plan: { engines: [...plan.engines], reasons: [...plan.reasons] },
      attempts: [],
      capabilities,
    };
    this.publish();
    return new DiagnosticsSession(this, this.id);
  }

  /** Applies a session's change; ignored once a newer source has started. */
  update(id: number, change: (r: PlaybackReport, elapsed: number) => void) {
    if (id !== this.id || !this.draft) return;
    change(this.draft, Math.round(performance.now() - this.started));
    this.publish();
  }

  clear() {
    this.id++;
    this.draft = null;
    this.publish();
  }

  snapshot = (): PlaybackReport | null => this.published;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private publish() {
    const d = this.draft;
    this.published = d ? { ...d, plan: { ...d.plan }, attempts: d.attempts.map((a) => ({ ...a })) } : null;
    for (const l of this.listeners) l();
  }
}

/** Records one source's attempts. Each method is a no-op once a newer source has started. */
export class DiagnosticsSession {
  constructor(
    private readonly store: DiagnosticsStore,
    private readonly id: number,
  ) {}

  private edit(change: (a: Attempt, elapsed: number) => void) {
    this.store.update(this.id, (r, elapsed) => {
      const a = r.attempts.at(-1);
      if (a) change(a, elapsed);
    });
  }

  attempt(engine: Engine) {
    this.store.update(this.id, (r, elapsed) => {
      const prev = r.attempts.at(-1);
      if (prev && prev.outcome !== "failed") prev.outcome = "replaced";
      r.attempts.push({ engine, startedMs: elapsed, outcome: "pending" });
    });
  }

  ready(media: MediaInfoSummary | null | undefined) {
    this.edit((a, elapsed) => {
      if (a.readyMs !== undefined || a.outcome === "failed") return;
      a.readyMs = elapsed;
      if (a.outcome === "pending") a.outcome = "ready";
      if (media) a.media = media;
    });
  }

  playing() {
    this.edit((a, elapsed) => {
      if (a.playingMs !== undefined || a.outcome === "failed") return;
      a.playingMs = elapsed;
      a.outcome = "playing";
    });
  }

  resolved(finalHost: string, retried: boolean) {
    this.edit((a) => {
      a.resolved = { finalHost, retried };
    });
  }

  failed(code: PlaybackErrorCode, message: string) {
    this.edit((a) => {
      a.outcome = "failed";
      a.code = code;
      a.message = message;
    });
  }
}

export const playbackDiagnostics = new DiagnosticsStore();

/** The report as text for the viewer to paste into an issue. Contains no URLs. */
export function reportText(report: PlaybackReport, extra?: unknown): string {
  return JSON.stringify({ ...report, ...(extra ? { decoders: extra } : {}) }, null, 2);
}
