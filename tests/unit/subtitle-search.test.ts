import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseRelease } from "@/lib/subtitles/search/release";
import { autoPick, rankCandidates, type Candidate } from "@/lib/subtitles/search/score";
import { findSubtitles, wantedFrom } from "@/lib/subtitles/search";
import { fromOpenSubtitles } from "@/lib/subtitles/search/opensubtitles";
import { downloadSubdl, fromSubdl } from "@/lib/subtitles/search/subdl";

function cand(over: Partial<Candidate> & { release: string }): Candidate {
  return {
    provider: "opensubtitles",
    id: over.release,
    language: "ar",
    hearingImpaired: false,
    machineTranslated: false,
    downloads: 100,
    rating: null,
    trusted: false,
    fps: null,
    ...over,
    feature: { imdbId: null, title: null, year: null, season: null, episode: null, ...over.feature },
  };
}

const movie = wantedFrom({
  name: "The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv",
  fileName: "The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv",
  imdbId: null,
});
const episode = wantedFrom({
  name: "Breaking.Bad.S05E14.720p.WEB-DL.DD5.1.H.264-NTb.mkv",
  fileName: "Breaking.Bad.S05E14.720p.WEB-DL.DD5.1.H.264-NTb.mkv",
  imdbId: null,
});

describe("parseRelease", () => {
  it("extracts guessit-style fields from release names", () => {
    expect(parseRelease("Shogun.2024.S01E03.2160p.DSNP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv")).toMatchObject({
      title: "Shogun",
      year: 2024,
      season: 1,
      episode: 3,
      releaseGroup: "FLUX",
      source: "WEB-DL",
      resolution: "2160p",
      videoCodec: "H.265",
      streamingService: "DSNP",
    });
    expect(parseRelease("Some.Movie.2020.WEBRip.x264").source).toBe("WEBRip");
    expect(parseRelease("Some.Movie.2020.BDRip.x264").source).toBe("BluRay");
  });
});

describe("rankCandidates", () => {
  it("auto-selects an exact movie title + year match", () => {
    const ranked = rankCandidates(movie, [
      cand({ release: "The Matrix 1999 Arabic", feature: { title: "The Matrix", year: 1999 } as Candidate["feature"] }),
      cand({ release: "Matrix Reloaded", feature: { title: "The Matrix Reloaded", year: 2003 } as Candidate["feature"] }),
    ]);
    expect(ranked[0].release).toBe("The Matrix 1999 Arabic");
    expect(ranked[0].confidence).toBe("high");
    expect(ranked[0].reasons).toEqual(expect.arrayContaining(["Title", "Year 1999", "Arabic"]));
    expect(autoPick(ranked)?.release).toBe("The Matrix 1999 Arabic");
  });

  it("ranks the wrong year below the right one and never trusts it", () => {
    const ranked = rankCandidates(movie, [
      cand({ release: "The.Matrix.2021.1080p.BluRay.x264-SPARKS", downloads: 99999, feature: { title: "The Matrix", year: 2021 } as Candidate["feature"] }),
      cand({ release: "The.Matrix.1999.720p.WEB", downloads: 1, feature: { title: "The Matrix", year: 1999 } as Candidate["feature"] }),
    ]);
    expect(ranked[0].feature.year).toBe(1999);
    const wrong = ranked.find((r) => r.feature.year === 2021)!;
    expect(wrong.confidence).toBe("low");
    expect(wrong.reasons).toContain("Different year (2021)");
    expect(autoPick([wrong])).toBeNull();
  });

  it("matches the episode and drops other episodes", () => {
    const ranked = rankCandidates(episode, [
      cand({ release: "Breaking.Bad.S05E13.720p.WEB-DL-NTb", feature: { title: "Breaking Bad", season: 5, episode: 13 } as Candidate["feature"] }),
      cand({ release: "Breaking.Bad.S05E14.HDTV.x264-ASAP", feature: { title: "Breaking Bad", season: 5, episode: 14 } as Candidate["feature"] }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].reasons).toContain("S05E14");
    expect(ranked[0].confidence).toBe("high");
  });

  it("prefers the same release group", () => {
    const f = { title: "Breaking Bad", season: 5, episode: 14 } as Candidate["feature"];
    const ranked = rankCandidates(episode, [
      cand({ release: "Breaking.Bad.S05E14.720p.HDTV.x264-OTHER", downloads: 5000, feature: f }),
      cand({ release: "Breaking.Bad.S05E14.720p.WEB-DL.H.264-NTb", downloads: 10, feature: f }),
    ]);
    expect(ranked[0].release).toContain("NTb");
    expect(ranked[0].reasons).toContain("Release group NTb");
  });

  it("prefers the same source (BluRay over WEB-DL for a BluRay video)", () => {
    const f = { title: "The Matrix", year: 1999 } as Candidate["feature"];
    const ranked = rankCandidates(movie, [
      cand({ release: "The.Matrix.1999.1080p.WEB-DL.H264", downloads: 9000, feature: f }),
      cand({ release: "The.Matrix.1999.1080p.BluRay.H264", downloads: 10, feature: f }),
    ]);
    expect(ranked[0].release).toContain("BluRay");
    expect(ranked[1].reasons).toContain("WEB-DL, not BluRay");
  });

  it("prefers Arabic over other languages", () => {
    const f = { title: "The Matrix", year: 1999 } as Candidate["feature"];
    const ranked = rankCandidates(movie, [
      cand({ release: "The.Matrix.1999.1080p.BluRay.x264-SPARKS", language: "en", feature: f }),
      cand({ release: "The.Matrix.1999.720p", language: "ar", feature: f }),
    ]);
    expect(ranked[0].language).toBe("ar");
    expect(ranked[1].confidence).toBe("low");
  });

  it("penalises hearing-impaired subtitles unless asked for", () => {
    const f = { title: "The Matrix", year: 1999 } as Candidate["feature"];
    const ranked = rankCandidates(movie, [
      cand({ release: "The.Matrix.1999.1080p", hearingImpaired: true, downloads: 9000, feature: f }),
      cand({ release: "The.Matrix.1999.1080p", hearingImpaired: false, downloads: 10, feature: f }),
    ]);
    expect(ranked[0].hearingImpaired).toBe(false);
    expect(ranked[1].reasons).toContain("Hearing impaired");
    const wantsHi = { ...movie, hearingImpaired: true };
    expect(rankCandidates(wantsHi, ranked)[0].hearingImpaired).toBe(true);
  });

  it("does not auto-select when only the title matches", () => {
    const noYear = wantedFrom({ name: "Big Buck Bunny - Official Blender Short Film", fileName: null, imdbId: null });
    const ranked = rankCandidates(noYear, [cand({ release: "Big Buck Bunny", feature: { title: "Big Buck Bunny", year: 2008 } as Candidate["feature"] })]);
    expect(ranked[0].confidence).toBe("low");
    expect(autoPick(ranked)).toBeNull();
  });

  it("treats the exact release file name as the best match", () => {
    const ranked = rankCandidates(movie, [
      cand({ release: "The.Matrix.1999.1080p.BluRay.x264-SPARKS", feature: {} as Candidate["feature"] }),
      cand({ release: "The Matrix 1999", feature: { title: "The Matrix", year: 1999 } as Candidate["feature"] }),
    ]);
    expect(ranked[0].reasons[0]).toBe("Exact release name");
    expect(ranked[0].percent).toBe(100);
    expect(ranked[0].confidence).toBe("high");
  });

  it("an IMDb id match implies title and year", () => {
    const byId = { ...movie, title: null, year: null, imdbId: "tt0133093" };
    const ranked = rankCandidates(byId, [cand({ release: "x", feature: { imdbId: "tt0133093" } as Candidate["feature"] })]);
    expect(ranked[0].confidence).toBe("high");
    expect(ranked[0].reasons).toContain("IMDb ID");
  });
});

describe("providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("maps OpenSubtitles results", () => {
    const [c] = fromOpenSubtitles({
      attributes: {
        language: "ar",
        download_count: 1234,
        hearing_impaired: false,
        release: "The.Matrix.1999.1080p.BluRay",
        files: [{ file_id: 42, file_name: "matrix.srt" }],
        feature_details: { feature_type: "Movie", title: "The Matrix", year: 1999, imdb_id: 133093 },
      },
    });
    expect(c).toMatchObject({ provider: "opensubtitles", id: "42", language: "ar", downloads: 1234 });
    expect(c.feature).toMatchObject({ imdbId: "tt0133093", title: "The Matrix", year: 1999 });
    expect(fromOpenSubtitles({ attributes: { files: [{ file_id: 1 }, { file_id: 2 }] } })).toEqual([]);
  });

  it("maps SubDL results and rejects unexpected download paths", () => {
    const [c] = fromSubdl(
      { release_name: "The.Matrix.1999.BluRay", language: "AR", url: "/subtitle/123-456.zip", hi: false },
      { name: "The Matrix", year: 1999, imdb_id: "tt0133093" },
    );
    expect(c).toMatchObject({ provider: "subdl", id: "/subtitle/123-456.zip", language: "ar" });
    expect(fromSubdl({ url: "https://evil.example/x.zip" }, undefined)).toEqual([]);
  });

  it("reports a provider failure without hiding other providers", async () => {
    vi.stubEnv("OPENSUBTITLES_API_KEY", "test-key");
    vi.stubEnv("SUBDL_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.opensubtitles.com")) return new Response("down", { status: 503 });
        return Response.json({
          status: true,
          results: [{ name: "The Matrix", year: 1999 }],
          subtitles: [{ release_name: "The.Matrix.1999.1080p.BluRay.x264-SPARKS", language: "AR", url: "/subtitle/1-2.zip" }],
        });
      }),
    );
    const found = await findSubtitles(movie);
    expect(found.errors).toEqual([{ provider: "opensubtitles", message: "OpenSubtitles error 503." }]);
    expect(found.results).toHaveLength(1);
    expect(found.autoSelect).toBe(true);
  });

  it("returns no results cleanly", async () => {
    vi.stubEnv("OPENSUBTITLES_API_KEY", "test-key");
    vi.stubEnv("SUBDL_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ total_count: 0, data: [] })));
    const found = await findSubtitles(movie);
    expect(found).toMatchObject({ results: [], autoSelect: false, errors: [] });
  });

  it("never puts the OpenSubtitles key in the URL", async () => {
    vi.stubEnv("OPENSUBTITLES_API_KEY", "secret-key");
    vi.stubEnv("SUBDL_API_KEY", "");
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await findSubtitles(movie);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("secret-key");
    expect(url).toContain("languages=ar");
    expect((init.headers as Record<string, string>)["Api-Key"]).toBe("secret-key");
  });

  it("unzips a SubDL download", async () => {
    const zip = zipSync({ "readme.txt": strToU8("hi"), "movie.ar.srt": strToU8("1\n00:00:01,000 --> 00:00:02,000\nمرحبا\n") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(zip)));
    const bytes = await downloadSubdl("/subtitle/1-2.zip", 2_000_000);
    expect(new TextDecoder().decode(bytes)).toContain("مرحبا");
    await expect(downloadSubdl("../etc/passwd", 2_000_000)).rejects.toThrow("Unknown subtitle.");
  });
});

describe("search route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/subtitles/search/route");
    return POST(new Request("http://localhost/api/subtitles/search", { method: "POST", body: JSON.stringify(body) }));
  };

  it("derives the release from the media file name, ignoring the signed query", async () => {
    vi.stubEnv("OPENSUBTITLES_API_KEY", "k");
    vi.stubEnv("SUBDL_API_KEY", "");
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await post({ kind: "file", url: "https://cdn.example/dl/The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv?token=SECRET" });
    const json = (await res.json()) as { wanted: { title: string; year: number } };
    expect(json.wanted).toMatchObject({ title: "The Matrix", year: 1999 });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).not.toContain("SECRET");
    expect(url).toContain("query=the%20matrix");
  });

  it("asks for a title when the URL says nothing", async () => {
    vi.stubEnv("OPENSUBTITLES_API_KEY", "k");
    const res = await post({ kind: "hls", url: "https://cdn.example/x36xhzz/x36xhzz.m3u8" });
    expect(await res.json()).toMatchObject({ needTitle: true, results: [] });
  });

  it("says when no provider is configured", async () => {
    vi.stubEnv("OPENSUBTITLES_API_KEY", "");
    vi.stubEnv("SUBDL_API_KEY", "");
    const res = await post({ kind: "file", url: "https://cdn.example/a.mkv" });
    expect(res.status).toBe(503);
  });
});
