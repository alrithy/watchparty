import { afterEach, describe, expect, it, vi } from "vitest";
import { publicPageCandidates } from "@/lib/media/public-page";
import { probeUrl } from "@/lib/media/probe";
import { prepareSource } from "@/lib/media/prepare";
import { NOT_DIRECT_MESSAGE } from "@/lib/media/source";

const publicDns = async () => ["93.184.216.34"];
const htmlResponse = (html: string) => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
const fake = (...responses: Response[]) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses.shift();
    if (!response) throw Error("unexpected request");
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

describe("public HTML media discovery", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("handles reordered Open Graph attributes and HTML-encoded signed queries", () => {
    const html = '<html><head><meta content="https://cdn.example.org/movie.mp4?x=1&amp;y=2" property="og:video:secure_url"></head></html>';
    expect(publicPageCandidates(html, "https://videos.example.com/watch/1")).toEqual(["https://cdn.example.org/movie.mp4?x=1&y=2"]);
  });

  it("extracts relative HTML video/source and link HLS while ignoring unrelated anchors", () => {
    const page = 'https://demo.example.com/watch/ep1';
    const html = '<a href="/ad.mp4">Ad</a><video poster="/img.jpg"><source src="../episodes/ep1.m3u8" type="application/vnd.apple.mpegurl"></video><link type="application/dash+xml" rel="alternate" href="/streams/film.mpd">';
    expect(publicPageCandidates(html, page)).toEqual([
      "https://demo.example.com/episodes/ep1.m3u8",
      "https://demo.example.com/streams/film.mpd",
    ]);
  });

  it("extracts explicitly published VideoObject JSON-LD contentUrl and supported provider embed", () => {
    const html = '<script type="application/ld+json">{"@graph":[{"@type":"VideoObject","contentUrl":"https://media.example.com/cdn?id=19","embedUrl":"https://www.youtube.com/embed/dQw4w9WgXcQ"},{"@type":"WebPage","url":"https://example.com/home"}]}</script>';
    expect(publicPageCandidates(html, "https://site.example/video")).toEqual([
      "https://media.example.com/cdn?id=19",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    ]);
  });

  it("filters out javascript:, file:, embedded credentials, and generic iframes", () => {
    const html = '<meta property="og:video" content="javascript:alert(1)"><source src="file:///etc/passwd"><video src="https://user:pass@host.example/x.mp4"></video><iframe src="https://third-party.example/watch"><\/iframe><iframe src="https://player.vimeo.com/video/1084537"></iframe>';
    expect(publicPageCandidates(html, "https://example.com/")).toEqual(["https://player.vimeo.com/video/1084537"]);
  });

  it("resolves a normal HTML OG media link to a verified direct video, not the page URL", async () => {
    const html = '<meta property="og:video" content="https://cdn.example.com/videos/clip.mp4?access=public">';
    const { fetchImpl, calls } = fake(
      new Response(null, { headers: { "content-type": "text/html" } }),
      htmlResponse(html),
      new Response(null, { headers: { "content-type": "video/mp4" } }),
    );
    const result = await probeUrl("https://video.example.com/watch/123", { fetchImpl, resolve: publicDns });
    expect(result).toMatchObject({ result: "playable", kind: "file", mediaUrl: "https://cdn.example.com/videos/clip.mp4?access=public" });
    expect(calls).toHaveLength(3);
    expect(calls[1].init.method).toBe("GET");
    expect((calls[1].init.headers as Record<string, string>).Range).toBeUndefined();
  });

  it("discovers native HLS from HTML metadata even when the URL has no extension", async () => {
    const { fetchImpl } = fake(
      new Response(null, { headers: { "content-type": "text/html" } }),
      htmlResponse('<meta name="twitter:player:stream" content="https://stream.example.com/session/123">'),
      new Response(null, { headers: { "content-type": "application/vnd.apple.mpegurl" } }),
    );
    expect(await probeUrl("https://example.com/episode", { fetchImpl, resolve: publicDns })).toMatchObject({
      result: "playable", kind: "hls", mediaUrl: "https://stream.example.com/session/123",
    });
  });

  it("finds a YouTube player iframe without attempting to fetch media bytes", async () => {
    const { fetchImpl, calls } = fake(
      new Response(null, { headers: { "content-type": "text/html" } }),
      htmlResponse('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>'),
    );
    expect(await probeUrl("https://example.com/article", { fetchImpl, resolve: publicDns })).toMatchObject({
      result: "playable", kind: "youtube", mediaUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    });
    expect(calls).toHaveLength(2);
  });

  it("refuses private embedded sources and false-positive HTML targets", async () => {
    const { fetchImpl, calls } = fake(
      new Response(null, { headers: { "content-type": "text/html" } }),
      htmlResponse('<meta property="og:video" content="http://169.254.169.254/latest.mp4"><source src="https://other.example.com/surprise.mp4">'),
      new Response(null, { headers: { "content-type": "text/html" } }),
    );
    expect(await probeUrl("https://example.com/watch", { fetchImpl, resolve: publicDns })).toEqual({ result: "not_media" });
    expect(calls).toHaveLength(3);
    expect(calls.some(x => x.url.includes("169.254.169.254"))).toBe(false);
  });

  it("does not treat ordinary HTML or JSON as video and preserves failure guidance", async () => {
    const { fetchImpl } = fake(
      new Response(null, { headers: { "content-type": "text/html" } }),
      htmlResponse("<html><p>Public page with no video</p></html>"),
    );
    expect(await probeUrl("https://example.com/", { fetchImpl, resolve: publicDns })).toEqual({ result: "not_media" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "not_media" }), { status: 200 })));
    expect(await prepareSource("https://example.com/watch")).toEqual({ error: NOT_DIRECT_MESSAGE });
  });

  it("preserves YouTube identity when the page points to a provider iframe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      result: "playable", kind: "youtube", mediaUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    expect(await prepareSource("https://example.com/tutorial")).toMatchObject({
      source: { kind: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });
  });

  it("classifies a declared public media URL into its actual HLS kind", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      result: "playable", kind: "hls", mediaUrl: "https://cdn.example.com/stream?id=1",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    expect(await prepareSource("https://example.com/show")).toMatchObject({ source: {
      kind: "hls", url: "https://cdn.example.com/stream?id=1",
    } });
  });
});
