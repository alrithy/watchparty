"use client";

import { useState, useSyncExternalStore } from "react";
import { playbackDiagnostics, reportText, type Attempt, type PlaybackReport } from "@/lib/media/diagnostics";
import { checkDecoders } from "@/lib/media/capabilities";

const ENGINE_NAMES: Record<string, string> = {
  native: "Browser player",
  hlsjs: "hls.js",
  dashjs: "dash.js",
  movi: "Movi decoder",
  youtube: "YouTube",
  vimeo: "Vimeo",
};

type Decoders = Awaited<ReturnType<typeof checkDecoders>>;

/**
 * This device's playback details: which engine plays the video, why, and what
 * failed. Collapsed by default; "Copy" gives a report without any URL path,
 * query string or file name, safe to paste into an issue.
 */
export function PlaybackDiagnostics() {
  const report = useSyncExternalStore(playbackDiagnostics.subscribe, playbackDiagnostics.snapshot, () => null);
  const [decoders, setDecoders] = useState<Decoders | null>(null);
  const [copied, setCopied] = useState(false);
  if (!report) return null;
  const active = report.attempts.at(-1);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportText(report, decoders ?? undefined));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm" data-testid="playback-diagnostics">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Playback details
        {active && (
          <span className="ml-2 font-mono normal-case tracking-normal text-zinc-300" data-testid="diag-engine" data-engine={active.engine}>
            {ENGINE_NAMES[active.engine] ?? active.engine}
            {active.code ? ` · ${active.code}` : ""}
          </span>
        )}
      </summary>
      <div className="mt-3 space-y-3 text-zinc-300">
        <p className="text-zinc-400">
          {report.source.kind} from <span className="font-mono">{report.source.host}</span>
          {report.source.extension && <> · .{report.source.extension}</>}
          {report.source.mime && <> · {report.source.mime}</>}
          {report.routing === "legacy" && <> · legacy routing</>}
        </p>
        <ul className="list-disc space-y-0.5 pl-5 text-zinc-400" data-testid="diag-reasons">
          {report.plan.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <ol className="space-y-1" data-testid="diag-attempts">
          {report.attempts.map((a, i) => (
            <AttemptRow key={i} a={a} />
          ))}
        </ol>
        <Capabilities report={report} />
        {decoders && <DecoderTable decoders={decoders} />}
        <div className="flex gap-2">
          {!decoders && (
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
              onClick={() => void checkDecoders().then(setDecoders, () => {})}
            >
              Check decoders
            </button>
          )}
          <button type="button" className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800" onClick={() => void copy()} data-testid="diag-copy">
            {copied ? "Copied" : "Copy report"}
          </button>
        </div>
      </div>
    </details>
  );
}

function AttemptRow({ a }: { a: Attempt }) {
  const color = a.outcome === "failed" ? "text-red-300" : a.outcome === "playing" || a.outcome === "ready" ? "text-emerald-300" : "text-zinc-400";
  const m = a.media;
  return (
    <li className="font-mono text-xs">
      <span className={color}>
        {ENGINE_NAMES[a.engine] ?? a.engine}: {a.outcome}
        {a.code ? ` (${a.code})` : ""}
      </span>
      {a.readyMs !== undefined && <span className="text-zinc-500"> · ready {a.readyMs} ms</span>}
      {a.playingMs !== undefined && <span className="text-zinc-500"> · playing {a.playingMs} ms</span>}
      {m && (
        <span className="text-zinc-500">
          {" "}
          · {m.width}×{m.height}
          {m.container ? ` ${m.container}` : ""}
          {m.videoCodec ? ` ${m.videoCodec}` : ""}
          {m.audioCodec ? ` / ${m.audioCodec}` : ""}
          {m.audioTracks !== undefined ? ` · ${m.audioTracks} audio` : ""}
        </span>
      )}
      {a.resolved && <span className="text-zinc-500"> · redirect → {a.resolved.finalHost}</span>}
    </li>
  );
}

function Capabilities({ report }: { report: PlaybackReport }) {
  const c = report.capabilities;
  const yes = (b: boolean) => (b ? "yes" : "no");
  const rows: [string, string][] = [
    ["Safari HLS", yes(c.appleNativeHls)],
    ["Media Source", c.mse],
    ["WebCodecs video/audio", `${yes(c.webCodecs.video)} / ${yes(c.webCodecs.audio)}`],
    ["Movi decoder", yes(c.movi)],
    ["Home Screen app", yes(c.standalone)],
    ["HEVC / Main10", `${c.canPlay["mp4/hevc(hvc1)"] || "no"} / ${c.canPlay["mp4/hevc-main10"] || "no"}`],
    ["AC-3 / E-AC-3", `${c.canPlay["mp4/ac-3"] || "no"} / ${c.canPlay["mp4/e-ac-3"] || "no"}`],
    ["MKV", c.canPlay.mkv || "no"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs" data-testid="diag-capabilities">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DecoderTable({ decoders }: { decoders: Decoders }) {
  const show = (v: boolean | null | undefined) => (v === null || v === undefined ? "n/a" : v ? "yes" : "no");
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
      {decoders.webCodecs.map((d) => (
        <div key={d.name} className="contents">
          <dt className="text-zinc-500">WebCodecs {d.name}</dt>
          <dd className="font-mono">{show(d.supported)}</dd>
        </div>
      ))}
      {decoders.mediaCapabilities.map((d) => (
        <div key={d.name} className="contents">
          <dt className="text-zinc-500">File {d.name}</dt>
          <dd className="font-mono">
            {show(d.supported)}
            {d.supported ? ` · smooth ${show(d.smooth)} · efficient ${show(d.powerEfficient)}` : ""}
          </dd>
        </div>
      ))}
    </dl>
  );
}
