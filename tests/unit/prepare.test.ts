import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSource } from "@/lib/media/prepare";

/** Stubs the browser's fetch to our API routes and records which were called. */
function api(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      calls.push(path);
      if (!(path in routes)) throw new Error(`unexpected ${path}`);
      return Response.json(routes[path]);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("prepareSource fast path", () => {
  it.each([
    "https://cdn.example/movie.mp4?token=abc",
    "https://cdn.example/stream/master.m3u8",
    "https://cdn.example/manifest.mpd",
    "https://cdn.example/Movie.2024.2160p.mkv",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/76979871",
  ])("%s needs no server request", async (url) => {
    const calls = api({});
    const r = await prepareSource(url);
    expect("source" in r).toBe(true);
    expect(calls).toEqual([]);
  });

  it("an extensionless CDN link is probed once and never page-discovered when it is media", async () => {
    const calls = api({ "/api/probe": { result: "playable", kind: "file", filename: "Movie.mkv", contentType: "video/x-matroska" } });
    const r = await prepareSource("https://debrid.example/d/ABC123");
    expect(r).toMatchObject({ source: { kind: "file", mime: "video/x-matroska", label: "Movie.mkv (debrid.example)", url: "https://debrid.example/d/ABC123" } });
    expect(calls).toEqual(["/api/probe"]);
  });

  it("an unknown probe answer still lets the browser try (unchanged)", async () => {
    const calls = api({ "/api/probe": { result: "unknown" } });
    expect(await prepareSource("https://cdn.example/x")).toMatchObject({ source: { kind: "file" } });
    expect(calls).toEqual(["/api/probe"]);
  });
});

describe("prepareSource page discovery", () => {
  it("recognised services that can't be synced yet are named without any request", async () => {
    const calls = api({});
    expect(await prepareSource("https://www.dailymotion.com/video/x8j5tqk")).toMatchObject({ code: "NO_EMBED_AVAILABLE", error: expect.stringContaining("Dailymotion") });
    expect(await prepareSource("https://www.netflix.com/watch/1")).toMatchObject({ code: "DRM_LICENSE_REQUIRED" });
    expect(calls).toEqual([]);
  });

  it("a web page goes on to discovery and plays what it found", async () => {
    const found = { kind: "hls", url: "https://cdn.example/a.m3u8", label: "Talk", page: { host: "news.example", via: "jsonld" } };
    const calls = api({ "/api/probe": { result: "not_media" }, "/api/media/discover": { result: "source", option: { source: found, via: "jsonld", verified: true } } });
    expect(await prepareSource("https://news.example/talk")).toEqual({ source: found });
    expect(calls).toEqual(["/api/probe", "/api/media/discover"]);
  });

  it("several videos come back as choices", async () => {
    api({ "/api/probe": { result: "not_media" }, "/api/media/discover": { result: "choose", options: [{ source: { kind: "file", url: "a", label: "a" } }, { source: { kind: "file", url: "b", label: "b" } }] } });
    const r = await prepareSource("https://news.example/gallery");
    expect("choose" in r && r.choose.length).toBe(2);
  });

  it("a page with no video gives the specific reason", async () => {
    api({ "/api/probe": { result: "not_media" }, "/api/media/discover": { result: "unsupported", code: "AUTH_REQUIRED", message: "needs login" } });
    expect(await prepareSource("https://news.example/private")).toEqual({ error: "needs login", code: "AUTH_REQUIRED" });
  });
});
