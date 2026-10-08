"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Download = { id: string; name: string; size: number | null };
type Variant = { quality: string; url: string };
type Result = { variants: Variant[]; durationSeconds: number | null; filename: string | null };
type ErrorResponse = { error?: { code?: string; message?: string } };
const endpoint = "/api/rd/compat";

export default function RdCompatibilityLab() {
  const [token, setToken] = useState("");
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [id, setId] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [url, setUrl] = useState("");
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { /* Browser state goes away when the tab closes. */ }, []);

  const call = async (action: "list" | "variants", selectedId?: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setPlaying(false);
    setUrl("");
    if (action === "variants") setResult(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        cache: "no-store", credentials: "same-origin",
        body: JSON.stringify({ action, token, ...(action === "variants" ? { id: selectedId || id } : {}) }),
      });
      const data = await response.json() as { downloads?: Download[]; result?: Result } & ErrorResponse;
      if (!response.ok) throw new Error(data.error?.message || "Real-Debrid did not accept the request.");
      if (action === "list") {
        setDownloads(data.downloads || []);
        if (!id && data.downloads?.length) setId(data.downloads[0].id);
      } else setResult(data.result || null);
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed."); }
    finally { setBusy(false); }
  };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-8 text-zinc-100">
      <Link href="/" className="text-sm text-zinc-400 hover:text-white">← Watch Party</Link>
      <h1 className="text-2xl font-semibold">Real-Debrid — Safari HLS compatibility lab</h1>
      <p className="text-sm text-zinc-400">Experimental. Use your own authorized Real-Debrid account. This page tests whether RD offers an Apple HLS rendition. It does not change a Watch Party room, share your key, or prove another viewer can access the link.</p>
      <section className="rounded-lg border border-zinc-700 p-4 space-y-3">
        <label className="block text-sm">Your RD API key (not stored)
          <input className="mt-1 w-full rounded border border-zinc-600 bg-zinc-950 p-3" type="password" autoComplete="off" spellCheck={false} value={token} onChange={e => setToken(e.target.value)} placeholder="Personal RD API key" />
        </label>
        <div className="flex gap-2">
          <button disabled={busy || token.length < 8} className="rounded bg-zinc-200 px-4 py-2 text-zinc-950 disabled:opacity-50" onClick={() => void call("list")}>List recent downloads</button>
          <button className="rounded border border-zinc-600 px-4 py-2" onClick={() => { setToken(""); setDownloads([]); setResult(null); setUrl(""); setId(""); }}>Clear</button>
        </div>
        <label className="block text-sm">Select a file from recent downloads
          <select className="mt-1 w-full rounded border border-zinc-600 bg-zinc-950 p-3" value={id} onChange={e => { setId(e.target.value); setResult(null); setUrl(""); }}>
            {!downloads.length && <option value="">No files loaded</option>}
            {downloads.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">Or enter the exact RD download ID from /downloads or /unrestrict/link
          <input className="mt-1 w-full rounded border border-zinc-600 bg-zinc-950 p-3 font-mono" value={id} onChange={e => setId(e.target.value.trim())} placeholder="Real-Debrid file ID" />
        </label>
        <button disabled={busy || token.length < 8 || id.length < 4} className="rounded bg-emerald-600 px-4 py-2 disabled:opacity-50" onClick={() => void call("variants")}>Find Apple HLS renditions</button>
        {busy && <p className="text-amber-300">Contacting Real-Debrid…</p>}
        {error && <p role="alert" className="text-red-300">{error}</p>}
      </section>
      {result && <section className="rounded-lg border border-zinc-700 p-4 space-y-3">
        <h2 className="font-semibold">Apple HLS renditions ({result.variants.length})</h2>
        <p className="text-sm text-zinc-400">Provider duration: {result.durationSeconds === null ? "Unknown — cannot verify timeline" : `${result.durationSeconds.toFixed(1)} seconds`}. Do not assume synchronization until original and HLS durations are checked.</p>
        <div className="flex flex-wrap gap-2">
          {result.variants.map((v, i) => <button key={i} className="rounded border border-zinc-500 px-3 py-2 text-sm" onClick={() => { setUrl(v.url); setPlaying(true); }}>Play {v.quality}</button>)}
        </div>
        {playing && url && <div className="space-y-2"><video key={url} className="aspect-video w-full bg-black" src={url} controls playsInline preload="metadata" onError={() => setError("Safari could not play this provider URL. Check account/IP restrictions or RD format availability.")} /><p className="text-sm text-zinc-400">Verify picture, audio, seeking, and duration in Safari. Playback happens directly from the provider, not Vercel.</p></div>}
      </section>}
      <p className="text-xs text-zinc-500">Never paste your RD key in chat or share your private streaming URLs. Signed HLS links are visible only in this local tab. Account/IP limits and playback compatibility still require testing on the actual device.</p>
    </main>
  );
}
