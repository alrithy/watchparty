"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Download = { id: string; name: string; size: number | null };
type Variant = { quality: string; url: string };
type Result = { variants: Variant[]; durationSeconds: number | null; filename: string | null };
type ErrorResponse = { error?: { code?: string; message?: string } };
type PlaybackPhase = "idle" | "loading" | "metadata" | "waiting" | "playing" | "paused" | "blocked" | "stalled" | "error";
type SafeMediaState = {
  readyState: number; networkState: number; width: number; height: number;
  duration: number | null; position: number; errorCode: number | null;
};
const endpoint = "/api/rd/compat";
const STARTUP_TIMEOUT_MS = 20000;
const APPLE_CONTROL_HLS = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8";
const initialState: SafeMediaState = {
  readyState: 0, networkState: 0, width: 0, height: 0,
  duration: null, position: 0, errorCode: null,
};

function safeMediaState(video: HTMLVideoElement): SafeMediaState {
  return {
    readyState: video.readyState,
    networkState: video.networkState,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
    position: Math.round(video.currentTime * 10) / 10,
    errorCode: video.error?.code ?? null,
  };
}

function mediaError(code: number | null): string {
  switch (code) {
    case 1: return "MEDIA_ABORTED: Safari stopped loading the stream.";
    case 2: return "MEDIA_NETWORK: Safari could not download the stream. Check the RD CDN, account/IP restrictions, or expired link.";
    case 3: return "MEDIA_DECODE: Safari could not decode the downloaded video/audio.";
    case 4: return "MEDIA_SOURCE: Safari rejected the HLS URL or its format. Check that RD actually serves a playable manifest.";
    default: return "Safari could not play the provider's HLS stream.";
  }
}

/**
 * This is a provider-compatibility test, NOT Watch Party room playback.
 * Sensitive RD bearer tokens are held only in this tab's React state.
 * Playback URLs stay in the media element; diagnostic output never includes them.
 */
export default function RdCompatibilityLab() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const startedAt = useRef(0);
  const hasStartedPlayback = useRef(false);
  const [token, setToken] = useState("");
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [id, setId] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [selectedQuality, setSelectedQuality] = useState<string | null>(null);
  const [phase, setPhase] = useState<PlaybackPhase>("idle");
  const [details, setDetails] = useState("");
  const [stats, setStats] = useState<SafeMediaState>(initialState);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const updateMedia = () => {
    if (videoRef.current) setStats(safeMediaState(videoRef.current));
  };

  useEffect(() => {
    if (!selectedQuality) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const seconds = Math.round((window.performance.now() - startedAt.current) / 1000);
      setElapsed(seconds);
      setStats(safeMediaState(video));
      // Safari can sit on a black element without emitting an 'error'.
      // Mark that as a timeout rather than incorrectly claiming unsupported codec/CORS.
      if (seconds * 1000 >= STARTUP_TIMEOUT_MS && !hasStartedPlayback.current) {
        setPhase((current) => {
          if (current === "loading" || current === "waiting" || current === "metadata") {
            setDetails("START_TIMEOUT: Safari has not entered playback after 20 seconds. Check readyState / networkState; the RD stream or device may be at fault.");
            return "stalled";
          }
          return current;
        });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [selectedQuality]);

  const stopVideo = () => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    startedAt.current = 0;
    hasStartedPlayback.current = false;
    setSelectedQuality(null);
    setPhase("idle");
    setDetails("");
    setStats(initialState);
    setElapsed(0);
  };

  const call = async (action: "list" | "variants", selectedId?: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    stopVideo();
    if (action === "variants") setResult(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        body: JSON.stringify({ action, token, ...(action === "variants" ? { id: selectedId || id } : {}) }),
      });
      const data = await response.json() as { downloads?: Download[]; result?: Result } & ErrorResponse;
      if (!response.ok) throw new Error(data.error?.message || "Real-Debrid did not accept the request.");
      if (action === "list") {
        setDownloads(data.downloads || []);
        if (!id && data.downloads?.length) setId(data.downloads[0].id);
      } else setResult(data.result || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  const playVideo = (quality: string, providerUrl: string, eventTimestamp: number) => {
    // Do NOT create the <video> after this click. Safari may otherwise lose the
    // user activation needed for unmuted playback.
    const video = videoRef.current;
    if (!video) {
      setDetails("The media element is not ready. Try again.");
      setPhase("error");
      return;
    }
    video.pause();
    setError("");
    setSelectedQuality(quality);
    setPhase("loading");
    setDetails("User-initiated request sent to Safari Native HLS.");
    setElapsed(0);
    setStats(initialState);
    startedAt.current = eventTimestamp;
    hasStartedPlayback.current = false;
    video.src = providerUrl;
    video.load();
    // Must occur synchronously inside the quality-button's user gesture.
    void video.play().then(() => {
      hasStartedPlayback.current = true;
      setPhase("playing");
      setDetails("Safari accepted play() and started playback.");
      setStats(safeMediaState(video));
    }).catch((e: unknown) => {
      const name = e instanceof Error ? e.name : "UnknownError";
      if (name === "NotAllowedError") {
        setPhase("blocked");
        setDetails("USER_GESTURE_REQUIRED: Safari blocked play(). Tap Start/Retry or the native video controls.");
      } else if (name === "AbortError") {
        // Selecting another rendition can abort the previous pending play().
        setPhase(current => current === "playing" ? current : "waiting");
        setDetails("PLAY_INTERRUPTED: Loading was interrupted. Try Start/Retry.");
      } else {
        setPhase("error");
        setDetails(`PLAY_REJECTED: ${name}. ${mediaError(video.error?.code ?? null)}`);
      }
      setStats(safeMediaState(video));
    });
  };

  const retry = (eventTimestamp: number) => {
    const video = videoRef.current;
    if (!video || !video.src) return;
    setDetails("User-initiated playback retry.");
    setPhase("loading");
    startedAt.current = eventTimestamp;
    hasStartedPlayback.current = false;
    void video.play().then(() => {
      hasStartedPlayback.current = true;
      setPhase("playing");
      setDetails("Safari accepted play() and started playback.");
      setStats(safeMediaState(video));
    }).catch((e: unknown) => {
      const name = e instanceof Error ? e.name : "UnknownError";
      setPhase(name === "NotAllowedError" ? "blocked" : "error");
      setDetails(name === "NotAllowedError"
        ? "USER_GESTURE_REQUIRED: Tap the native video play control."
        : `PLAY_REJECTED: ${name}. ${mediaError(video.error?.code ?? null)}`);
      setStats(safeMediaState(video));
    });
  };

  const clear = () => {
    stopVideo();
    setToken("");
    setDownloads([]);
    setResult(null);
    setId("");
    setError("");
  };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-8 text-zinc-100">
      <Link href="/" className="text-sm text-zinc-400 hover:text-white">← Watch Party</Link>
      <h1 className="text-2xl font-semibold">Real-Debrid — Safari HLS compatibility lab</h1>
      <p className="text-sm text-zinc-400">Experimental. Tests Apple HLS streaming with your own RD account. It does not change a Watch Party room or prove a guest on another IP can access the same rendition.</p>
      <section className="rounded-lg border border-zinc-700 p-4 space-y-3">
        <label className="block text-sm">Your RD API key (not stored)
          <input className="mt-1 w-full rounded border border-zinc-600 bg-zinc-950 p-3" type="password" autoComplete="off" spellCheck={false} value={token} onChange={e => setToken(e.target.value)} placeholder="Personal RD API key" />
        </label>
        <div className="flex gap-2">
          <button disabled={busy || token.length < 8} className="rounded bg-zinc-200 px-4 py-2 text-zinc-950 disabled:opacity-50" onClick={() => void call("list")}>List recent downloads</button>
          <button className="rounded border border-zinc-600 px-4 py-2" onClick={clear}>Clear</button>
        </div>
        <label className="block text-sm">Select a file from recent downloads
          <select className="mt-1 w-full rounded border border-zinc-600 bg-zinc-950 p-3" value={id} onChange={e => { setId(e.target.value); setResult(null); stopVideo(); }}>
            {!downloads.length && <option value="">No files loaded</option>}
            {downloads.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">Or enter the exact RD download ID from /downloads or /unrestrict/link
          <input className="mt-1 w-full rounded border border-zinc-600 bg-zinc-950 p-3 font-mono" value={id} onChange={e => { setId(e.target.value.trim()); setResult(null); stopVideo(); }} placeholder="Real-Debrid file ID" />
        </label>
        <button disabled={busy || token.length < 8 || id.length < 4} className="rounded bg-emerald-600 px-4 py-2 disabled:opacity-50" onClick={() => void call("variants")}>Find Apple HLS renditions</button>
        {busy && <p className="text-amber-300">Contacting Real-Debrid…</p>}
        {error && <p role="alert" className="text-red-300">{error}</p>}
      </section>
      {result && <section className="rounded-lg border border-zinc-700 p-4 space-y-3">
        <h2 className="font-semibold">Apple HLS renditions ({result.variants.length})</h2>
        <p className="text-sm text-zinc-400">Provider duration: {result.durationSeconds === null ? "Unknown — cannot verify timeline" : `${result.durationSeconds.toFixed(1)} seconds`}. The original and HLS timelines must match before room synchronization.</p>
        <div className="flex flex-wrap gap-2">
          {result.variants.map((v, i) => <button key={i} className="rounded border border-zinc-500 px-3 py-2 text-sm" onClick={event => playVideo(v.quality, v.url, event.timeStamp)}>Play {v.quality}</button>)}
          <button data-testid="apple-control-hls" className="rounded border border-sky-500 px-3 py-2 text-sm" onClick={event => playVideo("Apple HLS control", APPLE_CONTROL_HLS, event.timeStamp)}>Test Apple HLS (control)</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={!selectedQuality} onClick={event => retry(event.timeStamp)} className="rounded bg-zinc-100 px-3 py-2 text-sm text-zinc-950 disabled:opacity-50">Start / Retry playback</button>
          {selectedQuality && <span className="text-sm text-zinc-400">Quality: {selectedQuality}</span>}
        </div>
        <div className="rounded border border-zinc-700 bg-zinc-950 p-3 text-sm" data-testid="rd-playback-diagnostics" role="status">
          <p className="font-semibold">Playback status: <span className={phase === "playing" ? "text-emerald-300" : phase === "error" || phase === "blocked" || phase === "stalled" ? "text-amber-300" : "text-zinc-300"}>{phase.toUpperCase()}</span></p>
          <p className="mt-1 text-zinc-300">{details || "Choose a quality to begin playback."}</p>
          <p className="mt-2 font-mono text-xs text-zinc-400">Time: {elapsed}s · readyState {stats.readyState}/4 · networkState {stats.networkState} · error {stats.errorCode ?? "none"}</p>
          <p className="font-mono text-xs text-zinc-400">Picture: {stats.width}×{stats.height} · position {stats.position}s · duration {stats.duration === null ? "unknown" : `${stats.duration.toFixed(1)}s`}</p>
          <p className="mt-1 text-xs text-zinc-500">No keys, file links, signed queries or raw provider errors are included in these diagnostics.</p>
        </div>
        <video
          ref={videoRef}
          data-testid="rd-native-video"
          className="aspect-video w-full bg-black"
          controls
          playsInline
          preload="metadata"
          onLoadStart={() => { setPhase("loading"); updateMedia(); }}
          onLoadedMetadata={() => { setPhase("metadata"); setDetails("Safari loaded media metadata."); updateMedia(); }}
          onCanPlay={() => { updateMedia(); }}
          onPlaying={() => { hasStartedPlayback.current = true; setPhase("playing"); setDetails("Safari is rendering playback."); updateMedia(); }}
          onWaiting={() => { setPhase("waiting"); setDetails("BUFFERING: Waiting for media data from the provider."); updateMedia(); }}
          onStalled={() => { setPhase("stalled"); setDetails("STREAM_STALLED: The provider has not supplied more media data."); updateMedia(); }}
          onPause={() => { setPhase(current => current === "playing" ? "paused" : current); updateMedia(); }}
          onTimeUpdate={updateMedia}
          onError={() => {
            const code = videoRef.current?.error?.code ?? null;
            setPhase("error");
            setDetails(mediaError(code));
            updateMedia();
          }}
        />
        <p className="text-sm text-zinc-400">Choose a quality, then tap Start/Retry if needed. If there is still a black screen, report only the Playback status and numeric readyState/networkState/error — never your API key or the HLS URL.</p>
      </section>}
      <p className="text-xs text-zinc-500">RD URLs are signed. Never share your API token or a private streaming URL. Playback goes directly from the provider to Safari, not through Vercel.</p>
    </main>
  );
}
