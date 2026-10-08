import { afterEach, describe, expect, it, vi } from "vitest";
import { RD_API_BASE } from "@/lib/realdebrid/client";
import {
  durationCompatible, getRdAppleVariants, listRdDownloads, parseAppleVariants,
  parseDownloads, RdCompatError, validRdId,
} from "@/lib/realdebrid/compat";
import { POST } from "@/app/api/rd/compat/route";

const KEY = "SECURE_TEST_PERSONAL_API_TOKEN_123";
const ID = "DOWnLOad-123";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function mockFetch(...answers: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (!answers.length) throw new Error("Unexpected fetch");
    return answers.shift()!;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const candidates = {
  apple: {
    "480": "https://s.real-debrid.com/test480.m3u8?signed=abc",
    "2160": "https://s.real-debrid.com/test4k.m3u8?token=SIGNED",
    "1080": "https://s.real-debrid.com/test1080.m3u8",
  },
  dash: { "2160": "https://x.example/movie.mpd" },
};
const downloads = [{ id: ID, filename: "Movie.S01E01.mkv", filesize: 1024, download: "https://example.com/private?token=SECRET" }];
const request = (payload: unknown, headers: Record<string, string> = {}) => new Request("https://watch.example/api/rd/compat", {
  method: "POST",
  headers: { host: "watch.example", "Content-Type": "application/json", origin: "https://watch.example", ...headers },
  body: JSON.stringify(payload),
});

describe("Real-Debrid Phase C opt-in compat", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("accepts documented download IDs, rejects paths and URLs", () => {
    expect(validRdId(ID)).toBe(true);
    for (const bad of ["a", "../secret", "https://a.example", "x/y", "white space", null, 42]) expect(validRdId(bad)).toBe(false);
  });
  it("lists file identity only: strips signed download URLs and unknown types", () => {
    expect(parseDownloads([...downloads, { id: "x", filename: "bad" }, { id: "ABCDEF", filename: "another", filesize: 0 }])).toEqual([
      { id: ID, name: "Movie.S01E01.mkv", size: 1024 },
      { id: "ABCDEF", name: "another", size: 0 },
    ]);
    expect(() => parseDownloads({})).toThrow(RdCompatError);
  });
  it("prioritizes high-quality Apple HLS and discards invalid URLs", () => {
    expect(parseAppleVariants({ apple: { ...candidates.apple, invalid: "javascript:alert(1)", "720": "http://unsafe.test/file.m3u8", "4320": "https://user:pass@bad.test/master.m3u8" }, dash: candidates.dash }).map(x=>x.quality)).toEqual(["2160", "1080", "480"]);
    expect(parseAppleVariants({ dash: candidates.dash })).toEqual([]);
    expect(parseAppleVariants(null)).toEqual([]);
  });
  it("rejects unknown duration for automatic room synchronization", () => {
    expect(durationCompatible(3600, 3601)).toBe(true);
    expect(durationCompatible(3600, 3630)).toBe(false);
    expect(durationCompatible(3600, null)).toBe(false);
    expect(durationCompatible(0, 3600)).toBe(false);
  });
  it("calls fixed official endpoints with Authorization bearer, never query tokens", async () => {
    const { fetchImpl, calls } = mockFetch(json(downloads), json(candidates), json({ filename: "Movie.mkv", duration: 3415.2 }));
    const list = await listRdDownloads(KEY, fetchImpl);
    const variants = await getRdAppleVariants(ID, KEY, fetchImpl);
    expect(list[0].id).toBe(ID);
    expect(variants.durationSeconds).toBe(3415.2);
    expect(variants.filename).toBe("Movie.mkv");
    expect(variants.variants[0].quality).toBe("2160");
    expect(calls.map(c => c.url)).toEqual([
      `${RD_API_BASE}/downloads?limit=30`,
      `${RD_API_BASE}/streaming/transcode/${ID}`,
      `${RD_API_BASE}/streaming/mediaInfos/${ID}`,
    ]);
    for (const c of calls) {
      expect(c.url).not.toContain(KEY);
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      expect(c.init.redirect).toBe("error");
      expect(c.init.cache).toBe("no-store");
    }
  });
  it("returns variants even when media metadata endpoint is unavailable", async () => {
    const { fetchImpl } = mockFetch(json(candidates), json({ error_code: 25 }, 503));
    const result = await getRdAppleVariants(ID, KEY, fetchImpl);
    expect(result.variants).toHaveLength(3);
    expect(result.durationSeconds).toBeNull();
  });
  it("does not treat DASH-only output as Safari HLS", async () => {
    const { fetchImpl } = mockFetch(json({ dash: candidates.dash }));
    await expect(getRdAppleVariants(ID, KEY, fetchImpl)).rejects.toMatchObject({ code: "NO_HLS_VARIANT" });
  });
  it("uses stable, non-sensitive errors for bad token, IP block and rate limits", async () => {
    for (const [body, status, code] of [
      [{ error: "bad_token", error_code: 8 }, 401, "INVALID_TOKEN"],
      [{ error: "ip_not_allowed", error_code: 22 }, 503, "ACCOUNT_RESTRICTED"],
      [{ error: "slow_down", error_code: 34 }, 429, "RATE_LIMITED"],
    ] as const) {
      const { fetchImpl } = mockFetch(json(body, status));
      await expect(listRdDownloads(KEY, fetchImpl)).rejects.toMatchObject({ code });
    }
  });
  it("rejects oversized upstream JSON and never follows bearer-token redirects", async () => {
    const { fetchImpl } = mockFetch(new Response("x".repeat(270000), { status: 200 }));
    await expect(listRdDownloads(KEY, fetchImpl)).rejects.toMatchObject({ code: "RD_UNAVAILABLE" });
    const down = vi.fn(async () => { throw new TypeError("redirect blocked"); }) as unknown as typeof fetch;
    await expect(listRdDownloads(KEY, down)).rejects.toMatchObject({ code: "RD_UNAVAILABLE" });
  });
});

describe("POST /api/rd/compat", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("gives recent downloads but never echoes playback URLs or account key", async () => {
    const mock = mockFetch(json(downloads)); vi.stubGlobal("fetch", mock.fetchImpl);
    const res = await POST(request({ action: "list", token: KEY }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).downloads).toEqual([{ id: ID, name: "Movie.S01E01.mkv", size: 1024 }]);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(KEY);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
  it("returns signed HLS URL but never the personal bearer token", async () => {
    const mock = mockFetch(json(candidates), json({ duration: 120 })); vi.stubGlobal("fetch", mock.fetchImpl);
    const res = await POST(request({ action: "variants", id: ID, token: KEY }));
    const txt = await res.text();
    expect(res.status).toBe(200);
    expect(txt).toContain("test4k.m3u8");
    expect(txt).not.toContain(KEY);
  });
  it("blocks cross-site requests before calling RD", async () => {
    const fn = vi.fn(); vi.stubGlobal("fetch", fn);
    expect((await POST(request({ action: "list", token: KEY }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(request({ action: "list", token: KEY }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });
  it("validates token, action, ID and oversized requests", async () => {
    const fn = vi.fn(); vi.stubGlobal("fetch", fn);
    expect((await POST(request({ action: "list", token: "short" }))).status).toBe(400);
    expect((await POST(request({ action: "variants", token: KEY, id: "../test" }))).status).toBe(400);
    expect((await POST(request({ action: "delete", token: KEY }))).status).toBe(400);
    expect((await POST(request({ action: "list", token: KEY }, { "Content-Length": "9000" }))).status).toBe(413);
    expect(fn).not.toHaveBeenCalled();
  });
  it("sanitizes provider errors and never leaks raw provider response", async () => {
    const fn = mockFetch(json({ error: "bad_token: "+KEY, error_code: 8 }, 401)); vi.stubGlobal("fetch", fn.fetchImpl);
    const res = await POST(request({ action: "list", token: KEY }));
    expect(res.status).toBe(401);
    const txt = await res.text();
    expect(txt).not.toContain(KEY);
    expect(JSON.parse(txt).error.code).toBe("INVALID_TOKEN");
  });
});
