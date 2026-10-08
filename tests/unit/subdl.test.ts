import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { findSubtitles, wantedFrom } from "@/lib/subtitles/search";
import { downloadSubdl, fromSubdl, subdlPath, type SubdlSub } from "@/lib/subtitles/search/subdl";

/*
 * Shapes copied from SubDL's live replies for "Silo" S03E01 (2026-10-08): links
 * carry `?api_key=<our key>`, season packs have full_season:true and, with
 * unpack=1, an unpack_files list of single files.
 */
const KEY = "sd_TESTKEY-not-real";
const link = (path: string) => `${path}?api_key=${KEY}`;
const sub = (over: SubdlSub): SubdlSub => ({ lang: "Arabic", language: "AR", hi: false, full_season: false, ...over });
const SILO = { name: "Silo", year: 2023, imdb_id: "tt14688458", type: "tv" };

const E01 = sub({ release_name: "Silo.S03E01.Who.Are.You.1080p.WEBRip.10Bit.DDP5.1.x265-NeoNoir", url: link("/subtitle/3600001-3700001.zip"), season: 3, episode: 1, episode_from: 1, episode_end: 1 });
const E01b = sub({ release_name: "SILO S3 EP1", url: link("/subtitle/3600002-3700002.zip"), season: 3, episode: 1, episode_from: 1, episode_end: 1 });
const E02 = sub({ release_name: "Silo.S03E02.Its.All.Good.1080p.WEBRip.10Bit.DDP5.1.x265-NeoNoir", url: link("/subtitle/3600003-3700003.zip"), season: 3, episode: 2, episode_from: 2, episode_end: 2 });
const PACK = sub({ release_name: "Silo S03 Full Season", url: link("/subtitle/3600004-3700004.zip"), season: 3, episode: null, episode_from: null, episode_end: 0, full_season: true });
const PACK_UNPACKED = sub({
  ...PACK,
  unpack_files: [
    { name: "Silo.S03E01.Who.Are.You.1080p.ATVP.WEB-DL.DDP5.1.Atmos.H.264-FLUX.srt", season: 3, episode: 1, language: "AR", url: link("/subtitle/unpack4aaa/f1a2b3c4d5") },
    { name: "Silo.S03E02.Its.All.Good.1080p.ATVP.WEB-DL.DDP5.1.Atmos.H.264-FLUX.srt", season: 3, episode: 2, language: "AR", url: link("/subtitle/unpack4aaa/f9e8d7c6b5") },
  ],
});

const silo = wantedFrom({ name: "Silo S03E01.mp4", fileName: "Silo S03E01.mp4", imdbId: null });

type Reply = { status: number; body: unknown };
function subdlServer(route: (params: URLSearchParams) => Reply) {
  const calls: URLSearchParams[] = [];
  const fetchMock = vi.fn(async (input: string) => {
    const u = new URL(input);
    if (u.hostname !== "api.subdl.com") throw new Error(`unexpected ${u.hostname}`);
    calls.push(u.searchParams);
    const r = route(u.searchParams);
    return Response.json(r.body, { status: r.status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("SubDL links", () => {
  it("keeps only the path: the API key SubDL appends never becomes a candidate id", () => {
    expect(subdlPath(link("/subtitle/3600001-3700001.zip"))).toBe("/subtitle/3600001-3700001.zip");
    expect(subdlPath(`https://dl.subdl.com${link("/subtitle/unpack4aaa/f1a2b3c4d5")}`)).toBe("/subtitle/unpack4aaa/f1a2b3c4d5");
    for (const bad of ["https://evil.example/subtitle/1-2.zip", "//evil.example/subtitle/1-2.zip", "/subtitle/../../etc/passwd", "/download/1-2.zip", ""]) {
      expect(subdlPath(bad), bad).toBeNull();
    }
    const [c] = fromSubdl(E01, SILO, silo);
    expect(c.id).toBe("/subtitle/3600001-3700001.zip");
    expect(JSON.stringify(c)).not.toContain(KEY);
  });

  it("maps a season pack to the wanted episode only", () => {
    const unpacked = fromSubdl(PACK_UNPACKED, SILO, silo);
    expect(unpacked.map((c) => [c.id, c.feature.episode])).toEqual([["/subtitle/unpack4aaa/f1a2b3c4d5", 1]]);
    // Without unpack_files: one candidate that downloads the episode's file from the zip.
    expect(fromSubdl(PACK, SILO, silo).map((c) => c.id)).toEqual(["/subtitle/3600004-3700004.zip#S03E01"]);
    // A pack is never offered when we don't know the episode.
    expect(fromSubdl(PACK, SILO, { season: 3, episode: null })).toEqual([]);
    // Name-only language ("Arabic") is understood.
    expect(fromSubdl(sub({ ...E01, language: null }), SILO, silo)[0].language).toBe("ar");
  });
});

describe("SubDL search for Silo S03E01", () => {
  it("parses the sanitized file name as TV: Silo, season 3, episode 1", () => {
    expect(silo).toMatchObject({ title: "Silo", season: 3, episode: 1 });
  });

  it("finds Arabic candidates for the exact episode and never ranks another episode", async () => {
    vi.stubEnv("SUBDL_API_KEY", KEY);
    vi.stubEnv("OPENSUBTITLES_API_KEY", "");
    const calls = subdlServer(() => ({ status: 200, body: { status: true, results: [SILO], subtitles: [E01, PACK, E01b, E02] } }));
    const found = await findSubtitles(silo);
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0])).toMatchObject({ film_name: "Silo", type: "tv", season_number: "3", episode_number: "1", languages: "AR" });
    expect(found.errors).toEqual([]);
    expect(found.results.map((r) => r.id).sort()).toEqual(["/subtitle/3600001-3700001.zip", "/subtitle/3600002-3700002.zip", "/subtitle/3600004-3700004.zip#S03E01"]);
    expect(found.results.every((r) => r.feature.season === 3 && r.feature.episode === 1)).toBe(true);
    expect(found.autoSelect).toBe(true);
    expect(found.results[0].confidence).toBe("high");
    expect(found.diagnostics).toEqual([
      expect.objectContaining({ provider: "subdl", query: "episode", httpStatus: 200, providerStatus: true, results: 1, subtitles: 4, accepted: 4 }),
    ]);
    expect(found.rankingDropped).toEqual({ subdl: 1 });
    expect(JSON.stringify(found)).not.toContain(KEY);
  });

  it("falls back to the season's packs, matching only the requested episode", async () => {
    vi.stubEnv("SUBDL_API_KEY", KEY);
    vi.stubEnv("OPENSUBTITLES_API_KEY", "");
    const calls = subdlServer((p) =>
      p.get("full_season") === "1"
        ? { status: 200, body: { status: true, results: [SILO], subtitles: [PACK_UNPACKED, E02] } }
        : { status: 200, body: { status: true, results: [SILO], subtitles: [] } },
    );
    const found = await findSubtitles(silo);
    expect(calls.map((c) => c.get("full_season"))).toEqual([null, "1"]);
    expect(calls[1].get("unpack")).toBe("1");
    expect(found.results.map((r) => r.id)).toEqual(["/subtitle/unpack4aaa/f1a2b3c4d5"]);
    expect(found.diagnostics[1]).toMatchObject({ query: "season_pack", subtitles: 2, accepted: 1 });
  });

  it("uses the file name last, and only for subtitles that name this episode", async () => {
    vi.stubEnv("SUBDL_API_KEY", KEY);
    vi.stubEnv("OPENSUBTITLES_API_KEY", "");
    const calls = subdlServer((p) =>
      p.get("file_name")
        ? { status: 200, body: { status: true, results: [SILO], subtitles: [E02, sub({ ...E01, season: null, episode: null })] } }
        : { status: 200, body: { status: false, error: "Not found" } },
    );
    const found = await findSubtitles(silo);
    expect(calls.map((c) => c.get("file_name"))).toEqual([null, null, "Silo S03E01.mp4"]);
    expect(found.results.map((r) => r.release)).toEqual([E01.release_name]);
    expect(found.diagnostics[2].rejected).toEqual({ other_episode: 1 });
  });

  it("only offers wrong-episode subtitles as nothing, never as an automatic pick", async () => {
    vi.stubEnv("SUBDL_API_KEY", KEY);
    vi.stubEnv("OPENSUBTITLES_API_KEY", "");
    subdlServer(() => ({ status: 200, body: { status: true, results: [SILO], subtitles: [E02] } }));
    const found = await findSubtitles(silo);
    expect(found.results).toEqual([]);
    expect(found.autoSelect).toBe(false);
  });

  it("reports SubDL errors instead of 'no subtitles found'", async () => {
    vi.stubEnv("SUBDL_API_KEY", KEY);
    vi.stubEnv("OPENSUBTITLES_API_KEY", "");
    subdlServer(() => ({ status: 200, body: { status: false, error: "Daily request limit exceeded" } }));
    const limited = await findSubtitles(silo);
    expect(limited.errors).toEqual([{ provider: "subdl", message: "SubDL error: Daily request limit exceeded." }]);
    expect(limited.diagnostics[0]).toMatchObject({ httpStatus: 200, providerStatus: false, error: "Daily request limit exceeded" });

    subdlServer(() => ({ status: 403, body: { status: false, statusCode: 403, error: "not_authorized", message: "Not Authorized" } }));
    const denied = await findSubtitles(silo);
    expect(denied.errors).toEqual([{ provider: "subdl", message: "SubDL rejected our key." }]);
    expect(denied.diagnostics[0]).toMatchObject({ httpStatus: 403, error: "not_authorized" });
    expect(JSON.stringify([limited, denied])).not.toContain(KEY);
  });
});

describe("SubDL downloads", () => {
  const srt = (text: string) => strToU8(`1\n00:00:01,000 --> 00:00:04,000\n${text}\n`);

  it("adds the key on the server and takes the requested episode out of a season pack", async () => {
    vi.stubEnv("SUBDL_API_KEY", KEY);
    const zip = zipSync({
      "Silo.S03E02.srt": srt("الحلقة الثانية"),
      "Silo.S03E01.srt": srt("الحلقة الأولى"),
      "readme.txt": strToU8("x"),
    });
    const fetchMock = vi.fn(async () => new Response(zip));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = await downloadSubdl("/subtitle/3600004-3700004.zip#S03E01", 2_000_000);
    expect(new TextDecoder().decode(bytes)).toContain("الحلقة الأولى");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`https://dl.subdl.com/subtitle/3600004-3700004.zip?api_key=${KEY}`);
    await expect(downloadSubdl("/subtitle/3600004-3700004.zip#S03E09", 2_000_000)).rejects.toThrow("no file for this episode");
  });

  it("returns an unpacked single file as is", async () => {
    vi.stubEnv("SUBDL_API_KEY", KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(srt("مرحبا"))));
    const bytes = await downloadSubdl("/subtitle/unpack4aaa/f1a2b3c4d5", 2_000_000);
    expect(new TextDecoder().decode(bytes)).toContain("مرحبا");
    await expect(downloadSubdl("https://evil.example/subtitle/1-2.zip", 2_000_000)).rejects.toThrow("Unknown subtitle.");
  });
});
