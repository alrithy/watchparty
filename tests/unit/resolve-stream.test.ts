import { describe, expect, it } from "vitest";
import { resolveStream } from "@/lib/media/resolve-stream";

const pub = async (host: string) => (host.endsWith(".internal-cdn.example") ? ["10.1.2.3"] : ["93.184.216.34"]);
const ORIGIN = "https://watchparty.example";

type Hop = { status: number; headers?: Record<string, string> };

/** A scripted fetch: each URL answers with one response; records what was sent and what was read. */
function server(routes: Record<string, Hop>) {
  const calls: { url: string; init: RequestInit }[] = [];
  let bytesRead = 0;
  let cancelled = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const hop = routes[u];
    if (!hop) throw new TypeError("fetch failed");
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        bytesRead += 1;
        c.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled++;
      },
    }, { highWaterMark: 0 });
    return new Response(hop.status === 204 || hop.status === 304 ? null : body, { status: hop.status, headers: hop.headers });
  }) as typeof fetch;
  return { impl, calls, read: () => bytesRead, cancelled: () => cancelled };
}

const media = (extra: Record<string, string> = {}): Hop => ({
  status: 206,
  headers: { "content-type": "video/x-matroska", "content-range": "bytes 0-0/9000000000", ...extra },
});

describe("resolveStream", () => {
  it("returns the link itself when there is no redirect", async () => {
    const s = server({ "https://cdn.example/a.mkv": media({ "access-control-allow-origin": "*" }) });
    const r = await resolveStream("https://cdn.example/a.mkv", { fetchImpl: s.impl, resolve: pub, origin: ORIGIN });
    expect(r).toEqual({
      ok: true,
      originalUrl: "https://cdn.example/a.mkv",
      finalUrl: "https://cdn.example/a.mkv",
      redirected: false,
      hops: 0,
      status: 206,
      supportsRange: true,
      contentType: "video/x-matroska",
      cors: "allowed",
    });
  });

  it("follows one redirect", async () => {
    const s = server({
      "https://debrid.example/d/X": { status: 302, headers: { location: "https://node1.cdn.example/dl/X/a.mkv" } },
      "https://node1.cdn.example/dl/X/a.mkv": media(),
    });
    const r = await resolveStream("https://debrid.example/d/X", { fetchImpl: s.impl, resolve: pub });
    expect(r).toMatchObject({ ok: true, finalUrl: "https://node1.cdn.example/dl/X/a.mkv", redirected: true, hops: 1 });
  });

  it("follows a multi-hop chain of every redirect status", async () => {
    const s = server({
      "https://a.example/1": { status: 301, headers: { location: "https://b.example/2" } },
      "https://b.example/2": { status: 303, headers: { location: "https://c.example/3" } },
      "https://c.example/3": { status: 307, headers: { location: "https://d.example/4" } },
      "https://d.example/4": { status: 308, headers: { location: "https://e.example/5" } },
      "https://e.example/5": media(),
    });
    const r = await resolveStream("https://a.example/1", { fetchImpl: s.impl, resolve: pub });
    expect(r).toMatchObject({ ok: true, finalUrl: "https://e.example/5", hops: 4 });
  });

  it("resolves a relative Location against the hop that sent it", async () => {
    const s = server({
      "https://cdn.example/d/abc/start": { status: 302, headers: { location: "../file/a.mkv?t=1" } },
      "https://cdn.example/d/file/a.mkv?t=1": media(),
    });
    const r = await resolveStream("https://cdn.example/d/abc/start", { fetchImpl: s.impl, resolve: pub });
    expect(r).toMatchObject({ ok: true, finalUrl: "https://cdn.example/d/file/a.mkv?t=1" });
  });

  it("checks every hop and refuses a redirect into a private network", async () => {
    for (const target of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://localhost:3000/",
      "https://x.internal-cdn.example/a.mkv",
      "https://cdn.example:22/a.mkv",
      "file:///etc/passwd",
    ]) {
      const s = server({ "https://debrid.example/d/X": { status: 302, headers: { location: target } } });
      const r = await resolveStream("https://debrid.example/d/X", { fetchImpl: s.impl, resolve: pub });
      expect(r, target).toEqual({ ok: false, originalUrl: "https://debrid.example/d/X", reason: "blocked" });
      expect(s.calls).toHaveLength(1);
    }
  });

  it("refuses a private first hop without fetching it", async () => {
    const s = server({});
    expect(await resolveStream("http://10.0.0.5/a.mkv", { fetchImpl: s.impl, resolve: pub })).toMatchObject({ ok: false, reason: "blocked" });
    expect(await resolveStream("ftp://cdn.example/a.mkv", { fetchImpl: s.impl, resolve: pub })).toMatchObject({ ok: false, reason: "invalid" });
    expect(s.calls).toHaveLength(0);
  });

  it("stops on a redirect loop", async () => {
    const s = server({
      "https://a.example/1": { status: 302, headers: { location: "https://b.example/2" } },
      "https://b.example/2": { status: 302, headers: { location: "https://a.example/1" } },
    });
    expect(await resolveStream("https://a.example/1", { fetchImpl: s.impl, resolve: pub })).toMatchObject({ ok: false, reason: "loop" });
    expect(s.calls).toHaveLength(2);
  });

  it("stops after five redirects", async () => {
    const routes: Record<string, Hop> = {};
    for (let i = 0; i < 10; i++) routes[`https://h.example/${i}`] = { status: 302, headers: { location: `https://h.example/${i + 1}` } };
    const s = server(routes);
    expect(await resolveStream("https://h.example/0", { fetchImpl: s.impl, resolve: pub })).toMatchObject({ ok: false, reason: "too_many_redirects" });
    expect(s.calls).toHaveLength(6);
  });

  it("times out", async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
    expect(await resolveStream("https://slow.example/a.mkv", { fetchImpl: hang, resolve: pub, timeoutMs: 50 })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });

  it("reports an HTTP error at the end of the chain", async () => {
    const s = server({
      "https://debrid.example/d/X": { status: 302, headers: { location: "https://cdn.example/gone" } },
      "https://cdn.example/gone": { status: 404 },
    });
    expect(await resolveStream("https://debrid.example/d/X", { fetchImpl: s.impl, resolve: pub })).toMatchObject({
      ok: false,
      reason: "http_error",
      status: 404,
    });
  });

  it("says whether the final server supports Range and allows this origin", async () => {
    const run = async (hop: Hop) =>
      resolveStream("https://cdn.example/a.mkv", { fetchImpl: server({ "https://cdn.example/a.mkv": hop }).impl, resolve: pub, origin: ORIGIN });
    expect(await run(media({ "access-control-allow-origin": ORIGIN }))).toMatchObject({ supportsRange: true, cors: "allowed" });
    expect(await run(media())).toMatchObject({ supportsRange: true, cors: "missing" });
    expect(await run({ status: 200, headers: { "access-control-allow-origin": "https://other.example" } })).toMatchObject({
      supportsRange: false,
      cors: "missing",
    });
  });

  it("finds the final URL when only the redirect hop lacks CORS", async () => {
    const s = server({
      "https://debrid.example/d/X": { status: 302, headers: { location: "https://cdn.example/a.mkv" } },
      "https://cdn.example/a.mkv": media({ "access-control-allow-origin": "*" }),
    });
    expect(await resolveStream("https://debrid.example/d/X", { fetchImpl: s.impl, resolve: pub, origin: ORIGIN })).toMatchObject({
      ok: true,
      finalUrl: "https://cdn.example/a.mkv",
      cors: "allowed",
    });
  });

  it("keeps a signed query string byte-for-byte", async () => {
    const signed = "https://cdn.example/dl/a.mkv?Expires=1760000000&Signature=Ab%2Bc%2F%3D~x_y&Key-Pair-Id=K1&e=%E2%9C%93";
    const s = server({ "https://debrid.example/d/X": { status: 302, headers: { location: signed } }, [signed]: media() });
    const r = await resolveStream("https://debrid.example/d/X", { fetchImpl: s.impl, resolve: pub });
    expect(r).toMatchObject({ ok: true, finalUrl: signed });
    expect(s.calls[1].url).toBe(signed);
  });

  it("asks for one byte, sends no credentials, and never reads the body", async () => {
    const s = server({
      "https://debrid.example/d/X": { status: 302, headers: { location: "https://cdn.example/a.mkv" } },
      "https://cdn.example/a.mkv": { status: 200, headers: { "content-type": "video/mp4" } },
    });
    await resolveStream("https://debrid.example/d/X", { fetchImpl: s.impl, resolve: pub, origin: ORIGIN });
    for (const { init } of s.calls) {
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      const h = new Headers(init.headers);
      expect(h.get("range")).toBe("bytes=0-0");
      expect(h.get("origin")).toBe(ORIGIN);
      expect(h.has("cookie")).toBe(false);
      expect(h.has("authorization")).toBe(false);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(s.cancelled()).toBe(2);
    expect(s.read()).toBe(0);
  });
});
