import { describe, expect, it, vi } from "vitest";
import { NOT_DIRECT_MESSAGE, resolveSource } from "@/lib/media/source";
import { classify, isPrivateAddress, probeUrl } from "@/lib/media/probe";
import { decideCorrection, DRIFT_SEEK_NO_RATE, SEEK_COOLDOWN_NO_RATE_MS } from "@/lib/sync/drift";

const kindOf = (url: string) => {
  const r = resolveSource(url);
  return r.ok ? r.source.kind : `error: ${r.error}`;
};

describe("resolveSource", () => {
  it.each([
    ["https://example.com/movie.mp4", "file"],
    ["https://example.com/movie.MP4?token=abc", "file"],
    ["https://example.com/clip.webm", "file"],
    ["https://example.com/clip.mkv", "file"],
    ["https://example.com/master.m3u8", "hls"],
    ["https://example.com/live/index.m3u8?sig=1", "hls"],
    ["https://example.com/manifest.mpd", "dash"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "youtube"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://youtu.be/dQw4w9WgXcQ?si=xyz", "youtube"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "youtube"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "youtube"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "youtube"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "youtube"],
    ["youtu.be/dQw4w9WgXcQ", "youtube"],
    ["https://vimeo.com/76979871", "vimeo"],
    ["https://vimeo.com/channels/staffpicks/76979871", "vimeo"],
    ["https://player.vimeo.com/video/76979871?h=abcdef1234", "vimeo"],
    ["https://41.download.real-debrid.com/d/ABCDEF/Movie.2024.mp4", "file"],
    ["https://cdn.example.com/download/8f7a6b5c", "file"],
  ])("%s -> %s", (url, kind) => {
    expect(kindOf(url)).toBe(kind);
  });

  it("normalizes YouTube and Vimeo so host and guest load the same id", () => {
    const yt = resolveSource("https://youtu.be/dQw4w9WgXcQ?t=10");
    expect(yt.ok && yt.source).toMatchObject({ kind: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    const unlisted = resolveSource("https://vimeo.com/76979871/abcdef1234");
    expect(unlisted.ok && unlisted.source).toMatchObject({ kind: "vimeo", videoId: "76979871", hash: "abcdef1234" });
    const player = resolveSource("https://player.vimeo.com/video/76979871?h=abcdef1234");
    expect(player.ok && player.source).toMatchObject({ videoId: "76979871", hash: "abcdef1234" });
  });

  it("marks URLs without a hint as uncertain so the server can probe them", () => {
    const r = resolveSource("https://cdn.example.com/download/8f7a6b5c");
    expect(r.ok && r.certain).toBe(false);
    const known = resolveSource("https://example.com/a.mp4");
    expect(known.ok && known.certain).toBe(true);
  });

  it("rejects what can't be played directly", () => {
    expect(kindOf("")).toMatch(/error/);
    expect(kindOf("not a url")).toMatch(/error/);
    expect(kindOf("ftp://example.com/a.mp4")).toBe(`error: ${NOT_DIRECT_MESSAGE}`);
    expect(kindOf("magnet:?xt=urn:btih:abc")).toBe(`error: ${NOT_DIRECT_MESSAGE}`);
    expect(kindOf("https://www.youtube.com/playlist?list=PL123")).toBe(`error: ${NOT_DIRECT_MESSAGE}`);
    expect(kindOf("https://www.youtube.com/@channel")).toBe(`error: ${NOT_DIRECT_MESSAGE}`);
    expect(kindOf("https://vimeo.com/showcase/123456789")).toBe(`error: ${NOT_DIRECT_MESSAGE}`);
    expect(kindOf("https://vimeo.com/about")).toBe(`error: ${NOT_DIRECT_MESSAGE}`);
  });

  it("strips query strings from labels", () => {
    const r = resolveSource("https://cdn.example.com/dl/Movie.mp4?token=secret");
    expect(r.ok && r.source.label).toBe("Movie.mp4 (cdn.example.com)");
  });
});

describe("probe classify", () => {
  it.each([
    ["video/mp4", null, undefined, { result: "playable", kind: "file" }],
    ["video/webm; codecs=vp9", null, undefined, { result: "playable", kind: "file" }],
    ["application/vnd.apple.mpegurl", null, undefined, { result: "playable", kind: "hls" }],
    ["application/x-mpegURL", null, undefined, { result: "playable", kind: "hls" }],
    ["application/dash+xml", null, undefined, { result: "playable", kind: "dash" }],
    ["text/plain", null, "#EXTM3U\n#EXT-X-VERSION:3", { result: "playable", kind: "hls" }],
    ["application/xml", null, '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash">', { result: "playable", kind: "dash" }],
    ["application/octet-stream", null, undefined, { result: "playable", kind: "file" }],
    ["application/force-download", 'attachment; filename="Movie.mkv"', undefined, { result: "playable", kind: "file", filename: "Movie.mkv" }],
    ["text/html; charset=utf-8", null, "<!doctype html>", { result: "not_media" }],
    [null, null, undefined, { result: "unknown" }],
  ])("%s -> %o", (type, disposition, head, expected) => {
    expect(classify(type, disposition, head)).toMatchObject(expected);
  });
});

describe("probe SSRF guard", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true],
    ["8.8.8.8", false],
    ["2606:4700::1111", false],
  ])("%s private=%s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  const fake = (...responses: Response[]) =>
    vi.fn(async () => {
      const r = responses.shift();
      if (!r) throw new Error("unexpected request");
      return r;
    }) as unknown as typeof fetch;

  it("never requests private addresses, including through redirects", async () => {
    const direct = fake();
    expect(await probeUrl("http://127.0.0.1/a", { fetchImpl: direct })).toEqual({ result: "unknown" });
    expect(await probeUrl("http://internal.example/a", { fetchImpl: direct, resolve: async () => ["10.0.0.5"] })).toEqual({
      result: "unknown",
    });
    expect(direct).not.toHaveBeenCalled();

    const redirect = fake(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }));
    const r = await probeUrl("https://cdn.example.com/x", { fetchImpl: redirect, resolve: async (h) => (h === "cdn.example.com" ? ["93.184.216.34"] : ["169.254.169.254"]) });
    expect(r).toEqual({ result: "unknown" });
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("classifies from HEAD, follows public redirects, and falls back to a 2 KB ranged GET", async () => {
    const pub = async () => ["93.184.216.34"];
    const head = fake(new Response(null, { status: 200, headers: { "content-type": "video/mp4" } }));
    expect(await probeUrl("https://cdn.example.com/x", { fetchImpl: head, resolve: pub })).toMatchObject({ result: "playable", kind: "file" });

    const hopped = fake(
      new Response(null, { status: 302, headers: { location: "https://edge.example.com/y" } }),
      new Response(null, { status: 200, headers: { "content-type": "application/dash+xml" } }),
    );
    expect(await probeUrl("https://cdn.example.com/x", { fetchImpl: hopped, resolve: pub })).toMatchObject({ kind: "dash" });

    const calls: RequestInit[] = [];
    const refused = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return calls.length === 1
        ? new Response(null, { status: 405 })
        : new Response("#EXTM3U\n#EXTINF:4,\nseg0.ts\n", { status: 206, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    expect(await probeUrl("https://cdn.example.com/x", { fetchImpl: refused, resolve: pub })).toMatchObject({ kind: "hls" });
    expect(calls[1].method).toBe("GET");
    expect((calls[1].headers as Record<string, string>).Range).toBe("bytes=0-2047");
  });

  it("refuses odd ports and non-http schemes", async () => {
    const f = fake();
    expect(await probeUrl("https://cdn.example.com:22/x", { fetchImpl: f, resolve: async () => ["93.184.216.34"] })).toEqual({ result: "unknown" });
    expect(await probeUrl("file:///etc/passwd", { fetchImpl: f })).toEqual({ result: "unknown" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("decideCorrection without rate control", () => {
  it("ignores small drift and seeks past the wider threshold with a longer cooldown", () => {
    expect(decideCorrection(0.5, false, 10_000, false).action).toBe("none");
    expect(decideCorrection(DRIFT_SEEK_NO_RATE + 0.1, false, SEEK_COOLDOWN_NO_RATE_MS, false).action).toBe("seek");
    expect(decideCorrection(5, false, SEEK_COOLDOWN_NO_RATE_MS - 1, false).action).toBe("none");
    expect(decideCorrection(0.5, false, 10_000, true).action).toBe("rate");
  });
});
