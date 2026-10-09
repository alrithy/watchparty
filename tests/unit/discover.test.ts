import { describe, expect, it, vi } from "vitest";
import { cleanText, extractPage, parseDuration } from "@/lib/media/discover/extract";
import { discoverPage, PAGE_MAX_BYTES } from "@/lib/media/discover/discover";
import { isTrustedOembedEndpoint, providerSource } from "@/lib/media/discover/providers";
import type { ProbeResult } from "@/lib/media/probe";
import { RateLimiter } from "@/lib/http/rate-limit";

const PAGE = "https://news.example/watch/123";
const pub = async () => ["93.184.216.34"];

type Route = { status?: number; headers?: Record<string, string>; body?: string };

/** Scripted fetch: one response per URL; records every URL requested. */
function site(routes: Record<string, Route>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const r = routes[u];
    if (!r) throw new TypeError("fetch failed");
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": "text/html; charset=utf-8", ...r.headers } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Scripted header probe: URLs listed are media of that kind; others are unknown. */
function prober(media: Record<string, ProbeResult>) {
  const seen: string[] = [];
  const fn = vi.fn(async (url: string) => {
    seen.push(url);
    return media[url] ?? ({ result: "unknown" } as ProbeResult);
  });
  return { fn: fn as unknown as typeof import("@/lib/media/probe").probeUrl, seen };
}

const mp4: ProbeResult = { result: "playable", kind: "file", contentType: "video/mp4" };
const hls: ProbeResult = { result: "playable", kind: "hls" };

const html = (head: string, body = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("extractPage", () => {
  it("reads Open Graph video groups, preferring secure_url, and resolves relative URLs", () => {
    const m = extractPage(
      html(`<meta property="og:title" content="Launch &amp; Landing"><meta property="og:type" content="video.other">
        <meta property="og:video" content="http://cdn.example/v.mp4"><meta property="og:video:secure_url" content="https://cdn.example/v.mp4">
        <meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="1280">
        <meta property="og:image" content="https://cdn.example/poster.jpg">`),
      PAGE,
    );
    expect(m.title).toBe("Launch & Landing");
    expect(m.videoPage).toBe(true);
    const og = m.candidates.filter((c) => c.via === "opengraph");
    expect(og).toEqual([expect.objectContaining({ url: "https://cdn.example/v.mp4", role: "media", type: "video/mp4", width: 1280 })]);
    // og:image never becomes a candidate.
    expect(m.candidates.some((c) => c.url.endsWith("poster.jpg"))).toBe(false);
  });

  it("keeps signed query strings exactly (entities decoded, nothing stripped)", () => {
    const m = extractPage(html(`<meta property="og:video" content="https://cdn.example/a.m3u8?Expires=9&amp;Signature=abc~def&amp;Key-Pair-Id=K">`), PAGE);
    expect(m.candidates[0].url).toBe("https://cdn.example/a.m3u8?Expires=9&Signature=abc~def&Key-Pair-Id=K");
  });

  it("finds VideoObjects in JSON-LD, including @graph and nested video properties", () => {
    const ld = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", name: "x" },
        { "@type": "NewsArticle", video: { "@type": "VideoObject", name: "Clip", contentUrl: "/media/clip.mp4", embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ", duration: "PT1M30S" } },
      ],
    };
    const m = extractPage(html(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`), PAGE);
    expect(m.candidates).toEqual([
      expect.objectContaining({ url: "https://news.example/media/clip.mp4", via: "jsonld", role: "media", title: "Clip", duration: 90 }),
      expect.objectContaining({ url: "https://www.youtube.com/embed/dQw4w9WgXcQ", via: "jsonld", role: "embed" }),
    ]);
  });

  it("ignores malformed and oversized JSON-LD", () => {
    const big = `{"@type":"VideoObject","contentUrl":"https://cdn.example/big.mp4","pad":"${"x".repeat(300 * 1024)}"}`;
    const m = extractPage(html(`<script type="application/ld+json">{not json</script><script type="application/ld+json">${big}</script>`), PAGE);
    expect(m.candidates).toEqual([]);
  });

  it("reads <video> and <source>, honours <base href>, and marks background loops", () => {
    const m = extractPage(
      html(`<base href="https://static.example/assets/">`, `<video autoplay muted loop playsinline src="bg.mp4"></video>
        <video controls poster="p.jpg"><source src="main.webm" type="video/webm"><source src="main.mp4" type='video/mp4; codecs="avc1"'></video>`),
      PAGE,
    );
    expect(m.candidates.map((c) => [c.url, c.group, !!c.background, c.type])).toEqual([
      ["https://static.example/assets/bg.mp4", "video:0", true, undefined],
      ["https://static.example/assets/main.webm", "video:1", false, "video/webm"],
      ["https://static.example/assets/main.mp4", "video:1", false, "video/mp4"],
    ]);
  });

  it("drops non-http schemes and userinfo URLs", () => {
    const m = extractPage(
      html(`<meta property="og:video" content="javascript:alert(1)">`, `<video src="data:video/mp4;base64,AAAA"></video><video src="https://u:p@cdn.example/a.mp4"></video><iframe src="file:///etc/passwd"></iframe>`),
      PAGE,
    );
    expect(m.candidates).toEqual([]);
  });

  it("collects oEmbed discovery links and provider iframes", () => {
    const m = extractPage(
      html(`<link rel="alternate" type="application/json+oembed" href="https://vimeo.com/api/oembed.json?url=x">`, `<iframe data-src="https://player.vimeo.com/video/76979871"></iframe>`),
      PAGE,
    );
    expect(m.oembed).toEqual(["https://vimeo.com/api/oembed.json?url=x"]);
    expect(m.candidates).toEqual([expect.objectContaining({ url: "https://player.vimeo.com/video/76979871", via: "iframe", role: "embed" })]);
  });

  it("titles are plain text: markup stays text, control and bidi-override characters go", () => {
    const m = extractPage(html(`<title>&lt;img src=x onerror=alert(1)&gt; ‮evil\u0007</title>`), PAGE);
    expect(m.title).toBe("<img src=x onerror=alert(1)> evil");
    expect(cleanText("a".repeat(500))!.length).toBe(160);
  });

  it("parses ISO 8601 durations", () => {
    expect(parseDuration("PT1H2M3S")).toBe(3723);
    expect(parseDuration("PT45.5S")).toBe(45.5);
    expect(parseDuration("120")).toBe(120);
    expect(parseDuration("PT")).toBeUndefined();
    expect(parseDuration("soon")).toBeUndefined();
  });
});

describe("providers", () => {
  it("maps official embeds onto the existing YouTube/Vimeo players", () => {
    expect(providerSource("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0")).toMatchObject({ kind: "youtube", videoId: "dQw4w9WgXcQ" });
    expect(providerSource("https://player.vimeo.com/video/76979871?h=abcdef1234")).toMatchObject({ kind: "vimeo", videoId: "76979871", hash: "abcdef1234" });
    expect(providerSource("https://www.dailymotion.com/embed/video/x8j5tqk")).toBeNull();
    expect(providerSource("https://youtube.com.evil.example/embed/dQw4w9WgXcQ")).toBeNull();
  });

  it("trusts only the official oEmbed endpoints", () => {
    expect(isTrustedOembedEndpoint(new URL("https://www.youtube.com/oembed?url=x"))).toBe(true);
    expect(isTrustedOembedEndpoint(new URL("https://vimeo.com/api/oembed.xml?url=x"))).toBe(true);
    expect(isTrustedOembedEndpoint(new URL("https://news.example/wp-json/oembed/1.0/embed?url=x"))).toBe(false);
    expect(isTrustedOembedEndpoint(new URL("http://www.youtube.com/oembed"))).toBe(false);
    expect(isTrustedOembedEndpoint(new URL("https://www.youtube.com:8443/oembed"))).toBe(false);
  });
});

describe("discoverPage", () => {
  it("plays the page's Open Graph video once the probe confirms it is media", async () => {
    const s = site({ [PAGE]: { body: html(`<meta property="og:title" content="Rocket"><meta property="og:video" content="https://cdn.example/r.mp4?sig=1">`) } });
    const p = prober({ "https://cdn.example/r.mp4?sig=1": mp4 });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: p.fn });
    expect(r).toEqual({
      result: "source",
      option: {
        source: { kind: "file", url: "https://cdn.example/r.mp4?sig=1", label: "Rocket", mime: "video/mp4", page: { host: "news.example", via: "opengraph" } },
        via: "opengraph",
        title: "Rocket",
        verified: true,
      },
    });
  });

  it("prefers JSON-LD contentUrl and treats og/JSON-LD/<video> of one video as one", async () => {
    const ld = { "@type": "VideoObject", name: "Talk", contentUrl: "https://cdn.example/talk.m3u8", duration: "PT20M" };
    const s = site({
      [PAGE]: {
        body: html(
          `<meta property="og:video" content="https://cdn.example/talk.mp4"><script type="application/ld+json">${JSON.stringify(ld)}</script>`,
          `<video src="https://cdn.example/talk.mp4" controls></video>`,
        ),
      },
    });
    const p = prober({ "https://cdn.example/talk.m3u8": hls, "https://cdn.example/talk.mp4": mp4 });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: p.fn });
    expect(r).toMatchObject({ result: "source", option: { via: "jsonld", duration: 1200, source: { kind: "hls", url: "https://cdn.example/talk.m3u8" } } });
  });

  it("asks the host to pick when a page has several different videos", async () => {
    const s = site({
      [PAGE]: { body: html("<title>Gallery</title>", `<video src="/a.mp4" controls></video><video src="/b.mp4" controls></video><video autoplay muted loop src="/bg.mp4"></video>`) },
    });
    const p = prober({ "https://news.example/a.mp4": mp4, "https://news.example/b.mp4": mp4, "https://news.example/bg.mp4": mp4 });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: p.fn });
    expect(r.result).toBe("choose");
    if (r.result !== "choose") return;
    expect(r.options.map((o) => o.source.url)).toEqual(["https://news.example/a.mp4", "https://news.example/b.mp4"]);
    // Background loops are never probed or offered.
    expect(p.seen).not.toContain("https://news.example/bg.mp4");
  });

  it("prefers a rendition at or under 1080p over a 4K original (Wikimedia-style sources)", async () => {
    const s = site({
      [PAGE]: {
        body: html("<title>Bunny</title>", `<video controls><source src="/orig.webm" type="video/webm" data-file-width="4000" data-file-height="2250"><source src="/240.webm" type="video/webm" data-height="240"><source src="/360.mov" type="video/quicktime" data-height="360"><source src="/1080.webm" type="video/webm" data-width="1920" data-height="1080"><source src="/480.webm" type="video/webm" data-height="480"></video>`),
      },
    });
    const all = ["orig.webm", "240.webm", "360.mov", "1080.webm", "480.webm"].map((f) => `https://news.example/${f}`);
    const p = prober(Object.fromEntries(all.map((u) => [u, mp4])));
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: p.fn });
    expect(r).toMatchObject({ result: "source", option: { source: { url: "https://news.example/1080.webm" } } });
  });

  it("lists several JSON-LD VideoObjects with different names separately", async () => {
    const ld = [
      { "@type": "VideoObject", name: "Part 1", contentUrl: "https://cdn.example/1.mp4" },
      { "@type": "VideoObject", name: "Part 2", contentUrl: "https://cdn.example/2.mp4" },
    ];
    const s = site({ [PAGE]: { body: html(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`) } });
    const p = prober({ "https://cdn.example/1.mp4": mp4, "https://cdn.example/2.mp4": mp4 });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: p.fn });
    expect(r).toMatchObject({ result: "choose", options: [{ title: "Part 1" }, { title: "Part 2" }] });
  });

  it("never selects a URL just because metadata contains it", async () => {
    const s = site({ [PAGE]: { body: html(`<meta property="og:video" content="https://cdn.example/watch?id=5">`) } });
    const p = prober({ "https://cdn.example/watch?id=5": { result: "not_media" } });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: p.fn });
    expect(r).toMatchObject({ result: "unsupported", code: "PAGE_NOT_MEDIA" });
  });

  it("offers an unconfirmed media URL for the host to confirm instead of auto-playing it", async () => {
    const s = site({ [PAGE]: { body: html(`<meta property="og:video" content="https://ipbound.cdn.example/v.mp4?token=t">`) } });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: prober({}).fn });
    expect(r).toMatchObject({ result: "choose", options: [{ verified: false, source: { url: "https://ipbound.cdn.example/v.mp4?token=t" } }] });
  });

  it("filters ad and thumbnail URLs", async () => {
    const s = site({
      [PAGE]: { body: html(`<meta property="og:video" content="https://pubads.g.doubleclick.net/vast.mp4">`, `<video src="https://cdn.example/still.jpg"></video>`) },
    });
    const p = prober({});
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: p.fn });
    expect(r).toMatchObject({ result: "unsupported", code: "PAGE_NOT_MEDIA" });
    expect(p.seen).toEqual([]);
  });

  it("turns an Open Graph YouTube player into the room's YouTube source", async () => {
    const s = site({
      [PAGE]: { body: html(`<meta property="og:video:url" content="https://www.youtube.com/embed/dQw4w9WgXcQ"><meta property="og:video:type" content="text/html">`) },
    });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: prober({}).fn });
    expect(r).toMatchObject({ result: "source", option: { via: "opengraph", source: { kind: "youtube", videoId: "dQw4w9WgXcQ", page: { host: "news.example" } } } });
  });

  it("shows a lone embedded iframe for confirmation rather than auto-playing it", async () => {
    const s = site({ [PAGE]: { body: html("", `<p>Article</p><iframe src="https://player.vimeo.com/video/76979871"></iframe>`) } });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: prober({}).fn });
    expect(r).toMatchObject({ result: "choose", options: [{ via: "iframe", source: { kind: "vimeo" } }] });
  });

  it("follows a trusted oEmbed endpoint and uses only its iframe src", async () => {
    const endpoint = "https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F76979871&format=json";
    const s = site({
      [PAGE]: { body: html(`<link rel="alternate" type="application/json+oembed" href="https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F76979871">`) },
      [endpoint]: {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "video", title: "Big", html: `<iframe src="https://player.vimeo.com/video/76979871" onload="alert(1)"></iframe><script>alert(2)</script>` }),
      },
    });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: prober({}).fn });
    expect(r).toMatchObject({ result: "source", option: { via: "oembed", source: { kind: "vimeo", videoId: "76979871" } } });
    expect(JSON.stringify(r)).not.toMatch(/alert|script|onload/);
  });

  it("never fetches an untrusted oEmbed endpoint", async () => {
    const s = site({ [PAGE]: { body: html(`<link rel="alternate" type="application/json+oembed" href="https://evil.example/oembed?url=x">`) } });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: prober({}).fn });
    expect(r).toMatchObject({ result: "unsupported", code: "PAGE_NOT_MEDIA" });
    expect(s.calls).toEqual([PAGE]);
  });

  it("names recognised providers and DRM services without fetching anything", async () => {
    const s = site({});
    expect(await discoverPage("https://www.dailymotion.com/video/x8j5tqk", { fetchImpl: s.impl, resolve: pub })).toMatchObject({ code: "NO_EMBED_AVAILABLE", message: expect.stringContaining("Dailymotion") });
    expect(await discoverPage("https://www.netflix.com/watch/80100172", { fetchImpl: s.impl, resolve: pub })).toMatchObject({ code: "DRM_LICENSE_REQUIRED" });
    expect(s.calls).toEqual([]);
  });

  it("Streamable pages are still discovered (their og:video is an MP4)", async () => {
    const page = "https://streamable.com/moo";
    const s = site({ [page]: { body: html(`<meta property="og:video" content="https://api-f.streamable.com/api/v1/videos/moo/mp4">`) } });
    const r = await discoverPage(page, { fetchImpl: s.impl, resolve: pub, probe: prober({ "https://api-f.streamable.com/api/v1/videos/moo/mp4": mp4 }).fn });
    expect(r).toMatchObject({ result: "source", option: { source: { kind: "file", page: { host: "streamable.com" } } } });
  });

  it("names a recognised provider embedded in a page", async () => {
    const s = site({ [PAGE]: { body: html("", `<iframe src="https://www.dailymotion.com/embed/video/x8j5tqk"></iframe>`) } });
    expect(await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: prober({}).fn })).toMatchObject({ code: "NO_EMBED_AVAILABLE", message: expect.stringContaining("Dailymotion") });
  });

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "SOURCE_UNAVAILABLE"],
    [404, "LINK_EXPIRED"],
    [410, "LINK_EXPIRED"],
    [429, "SOURCE_UNAVAILABLE"],
    [503, "SOURCE_UNAVAILABLE"],
  ])("HTTP %s → %s", async (status, code) => {
    const s = site({ [PAGE]: { status } });
    expect(await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub })).toMatchObject({ result: "unsupported", code });
  });

  it("refuses private destinations, including through a redirect", async () => {
    const s = site({ [PAGE]: { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } } });
    const resolve = async (h: string) => (h === "169.254.169.254" ? ["169.254.169.254"] : ["93.184.216.34"]);
    expect(await discoverPage(PAGE, { fetchImpl: s.impl, resolve })).toMatchObject({ code: "BLOCKED_DESTINATION" });
    expect(s.calls).toEqual([PAGE]);
    expect(await discoverPage("http://10.0.0.8/page", { fetchImpl: s.impl, resolve })).toMatchObject({ code: "BLOCKED_DESTINATION" });
    expect(await discoverPage("http://localhost:3000/page", { fetchImpl: s.impl, resolve })).toMatchObject({ code: "BLOCKED_DESTINATION" });
    expect(await discoverPage("http://news.example:6379/", { fetchImpl: s.impl, resolve })).toMatchObject({ code: "BLOCKED_DESTINATION" });
  });

  it("refuses a host whose DNS answer turns private (rebinding)", async () => {
    let n = 0;
    const rebinding = async () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const s = site({ [PAGE]: { status: 302, headers: { location: "https://news.example/again" } } });
    expect(await discoverPage(PAGE, { fetchImpl: s.impl, resolve: rebinding })).toMatchObject({ code: "BLOCKED_DESTINATION" });
  });

  it("stops redirect loops and long chains", async () => {
    const loop = site({ [PAGE]: { status: 302, headers: { location: "https://news.example/b" } }, "https://news.example/b": { status: 302, headers: { location: PAGE } } });
    expect(await discoverPage(PAGE, { fetchImpl: loop.impl, resolve: pub })).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 10; i++) routes[i ? `https://news.example/${i}` : PAGE] = { status: 302, headers: { location: `https://news.example/${i + 1}` } };
    const chain = site(routes);
    expect(await discoverPage(PAGE, { fetchImpl: chain.impl, resolve: pub })).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(chain.calls.length).toBe(6);
  });

  it("a redirect to YouTube becomes the YouTube source", async () => {
    const s = site({ [PAGE]: { status: 301, headers: { location: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } } });
    expect(await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub })).toMatchObject({ result: "source", option: { source: { kind: "youtube" } } });
  });

  it("a link that turns out to be media is returned as pasted", async () => {
    const s = site({ [PAGE]: { headers: { "content-type": "video/mp4" } } });
    expect(await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub })).toMatchObject({ result: "source", option: { source: { kind: "file", url: PAGE } } });
  });

  it("JSON and other non-HTML answers are not pages", async () => {
    const s = site({ [PAGE]: { headers: { "content-type": "application/json" }, body: "{}" } });
    expect(await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub })).toMatchObject({ code: "PAGE_NOT_MEDIA" });
  });

  it("reads at most PAGE_MAX_BYTES of an oversized page", async () => {
    let pulled = 0;
    const impl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(html(`<meta property="og:video" content="https://cdn.example/v.mp4">`)));
          },
          pull(c) {
            pulled += 64 * 1024;
            c.enqueue(new Uint8Array(64 * 1024).fill(32));
          },
        }, { highWaterMark: 0 }),
        { headers: { "content-type": "text/html" } },
      )) as unknown as typeof fetch;
    const r = await discoverPage(PAGE, { fetchImpl: impl, resolve: pub, probe: prober({ "https://cdn.example/v.mp4": mp4 }).fn });
    expect(r.result).toBe("source");
    expect(pulled).toBeLessThanOrEqual(PAGE_MAX_BYTES + 64 * 1024);
  });

  it("reports a timeout", async () => {
    const impl = (async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    expect(await discoverPage(PAGE, { fetchImpl: impl, resolve: pub })).toMatchObject({ code: "NETWORK_TIMEOUT" });
  });

  it("survives malformed HTML", async () => {
    const s = site({ [PAGE]: { body: `<html><head><meta property="og:video" content="https://cdn.example/v.mp4"<video src=<<<"x"><script>${"{".repeat(1000)}` } });
    const r = await discoverPage(PAGE, { fetchImpl: s.impl, resolve: pub, probe: prober({}).fn });
    expect(["unsupported", "choose", "source"]).toContain(r.result);
  });
});

describe("RateLimiter", () => {
  it("limits per client per window and caps concurrency", () => {
    let t = 0;
    const l = new RateLimiter(2, 1000, 2, () => t);
    const a = l.acquire("a");
    const b = l.acquire("a");
    expect(a.ok && b.ok).toBe(true);
    expect(l.acquire("a")).toEqual({ ok: false, reason: "rate" });
    expect(l.acquire("b")).toEqual({ ok: false, reason: "busy" });
    if (a.ok) a.release();
    expect(l.acquire("b").ok).toBe(true);
    t = 1001;
    if (b.ok) b.release();
    expect(l.acquire("a").ok).toBe(true);
  });
});
