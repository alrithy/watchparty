import { afterEach, describe, expect, it, vi } from "vitest";
import { RD_API_BASE } from "@/lib/realdebrid/client";
import {
  mapRdError,
  parseUnrestrictResponse,
  redactUrl,
  resolveHostLink,
  validateHostLink,
} from "@/lib/realdebrid/resolve";
import { POST } from "@/app/api/resolve/route";

const TOKEN = "SECRET_TEST_TOKEN_123";
const LINK = "https://1fichier.com/?abc123";
const unrestricted = {
  id: "ABCDEF",
  filename: "Movie.2024.mp4",
  mimeType: "video/mp4",
  filesize: 123456789,
  link: LINK,
  host: "1fichier.com",
  chunks: 32,
  crc: 1,
  download: "https://41.download.real-debrid.com/d/ABCDEF/Movie.2024.mp4",
  streamable: 1,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Fake fetch that answers each call in turn and records requests. */
function fakeFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("parseUnrestrictResponse", () => {
  it("returns only what the browser needs", () => {
    expect(parseUnrestrictResponse(unrestricted)).toEqual({
      url: unrestricted.download,
      filename: "Movie.2024.mp4",
      mimeType: "video/mp4",
      filesize: 123456789,
    });
  });
  it("takes the first link of a multi-link response", () => {
    const media = parseUnrestrictResponse([unrestricted, { ...unrestricted, download: "https://x.example/2" }]);
    expect(media?.url).toBe(unrestricted.download);
  });
  it("upgrades http links to https to avoid mixed content", () => {
    expect(parseUnrestrictResponse({ ...unrestricted, download: "http://a.download.real-debrid.com/d/X/f.mp4" })?.url).toBe(
      "https://a.download.real-debrid.com/d/X/f.mp4",
    );
  });
  it("normalizes unknown size and type", () => {
    const media = parseUnrestrictResponse({ ...unrestricted, filesize: 0, mimeType: "" });
    expect(media?.filesize).toBeNull();
    expect(media?.mimeType).toBeNull();
  });
  it("rejects bodies without a usable download link", () => {
    expect(parseUnrestrictResponse(null)).toBeNull();
    expect(parseUnrestrictResponse([])).toBeNull();
    expect(parseUnrestrictResponse({ filename: "x" })).toBeNull();
    expect(parseUnrestrictResponse({ download: "javascript:alert(1)" })).toBeNull();
  });
});

describe("mapRdError", () => {
  const cases: [number, number | undefined, string, number][] = [
    [401, 8, "invalid_token", 502],
    [401, undefined, "invalid_token", 502],
    [403, 14, "account_locked", 502],
    [403, undefined, "account_locked", 502],
    [503, 16, "unsupported_host", 422],
    [503, 24, "link_unavailable", 422],
    [404, 7, "link_unavailable", 422],
    [503, undefined, "link_unavailable", 422],
    [503, 19, "hoster_unavailable", 503],
    [503, 22, "ip_not_allowed", 502],
    [503, 23, "traffic_exhausted", 502],
    [503, 36, "traffic_exhausted", 502],
    [429, undefined, "rate_limited", 429],
    [429, 34, "rate_limited", 429],
    [400, 5, "rate_limited", 429],
    [400, 2, "invalid_link", 400],
    [0, undefined, "upstream_error", 502],
    [500, -1, "upstream_error", 502],
  ];
  it.each(cases)("HTTP %i code %s -> %s", (status, code, expected, httpStatus) => {
    const e = mapRdError(status, { error: "x", error_code: code });
    expect(e.code).toBe(expected);
    expect(e.status).toBe(httpStatus);
    expect(e.message.length).toBeGreaterThan(0);
  });
});

describe("validateHostLink", () => {
  it("accepts http(s) links and rejects the rest", () => {
    expect(validateHostLink(LINK)).toBeNull();
    expect(validateHostLink("")?.code).toBe("invalid_link");
    expect(validateHostLink(42)?.code).toBe("invalid_link");
    expect(validateHostLink("not a url")?.code).toBe("invalid_link");
    expect(validateHostLink("ftp://x.example/f")?.code).toBe("invalid_link");
    expect(validateHostLink("magnet:?xt=urn:btih:abc")?.code).toBe("unsupported_host");
    expect(validateHostLink(`https://x.example/${"a".repeat(3000)}`)?.code).toBe("invalid_link");
  });
});

describe("redactUrl", () => {
  it("keeps only the hostname", () => {
    expect(redactUrl(unrestricted.download)).toBe("41.download.real-debrid.com/…");
    expect(redactUrl("garbage")).toBe("invalid-url");
  });
});

describe("resolveHostLink", () => {
  it("calls /unrestrict/link with the token in the Authorization header only", async () => {
    const { impl, calls } = fakeFetch(json(200, unrestricted));
    const result = await resolveHostLink(LINK, { token: TOKEN, fetchImpl: impl });
    expect(result).toEqual({ ok: true, remote: false, media: parseUnrestrictResponse(unrestricted) });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${RD_API_BASE}/unrestrict/link`);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("link")).toBe(LINK);
    expect(body.get("remote")).toBeNull();
    expect(String(calls[0].init.body)).not.toContain(TOKEN);
  });

  it("retries once with remote=1 when the IP is not allowed", async () => {
    const { impl, calls } = fakeFetch(json(503, { error: "ip_not_allowed", error_code: 22 }), json(200, unrestricted));
    const result = await resolveHostLink(LINK, { token: TOKEN, fetchImpl: impl });
    expect(result.ok && result.remote).toBe(true);
    expect(new URLSearchParams(String(calls[1].init.body)).get("remote")).toBe("1");
  });

  it("reports ip_not_allowed when remote traffic is refused too", async () => {
    const { impl } = fakeFetch(
      json(503, { error: "ip_not_allowed", error_code: 22 }),
      json(503, { error: "ip_not_allowed", error_code: 22 }),
    );
    const result = await resolveHostLink(LINK, { token: TOKEN, fetchImpl: impl });
    expect(!result.ok && result.error.code).toBe("ip_not_allowed");
  });

  it("does not retry other errors", async () => {
    const { impl, calls } = fakeFetch(json(401, { error: "bad_token", error_code: 8 }));
    const result = await resolveHostLink(LINK, { token: TOKEN, fetchImpl: impl });
    expect(!result.ok && result.error.code).toBe("invalid_token");
    expect(calls).toHaveLength(1);
  });

  it("handles non-JSON error bodies and network failures", async () => {
    const html = fakeFetch(new Response("<html>Service Unavailable</html>", { status: 503 }));
    const r1 = await resolveHostLink(LINK, { token: TOKEN, fetchImpl: html.impl });
    expect(!r1.ok && r1.error.code).toBe("link_unavailable");
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r2 = await resolveHostLink(LINK, { token: TOKEN, fetchImpl: down });
    expect(!r2.ok && r2.error.code).toBe("upstream_error");
  });

  it("rejects a 200 without a download link", async () => {
    const { impl } = fakeFetch(json(200, { id: "x" }));
    const result = await resolveHostLink(LINK, { token: TOKEN, fetchImpl: impl });
    expect(!result.ok && result.error.code).toBe("upstream_error");
  });
});

describe("POST /api/resolve", () => {
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://watch.example/api/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "watch.example", ...headers },
      body: JSON.stringify(body),
    });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves with the server token and never echoes or logs secrets", async () => {
    vi.stubEnv("REAL_DEBRID_TOKEN", TOKEN);
    const { impl } = fakeFetch(json(200, unrestricted));
    vi.stubGlobal("fetch", impl);
    const logs: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
    }
    const res = await POST(request({ link: LINK }, { origin: "https://watch.example" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ media: parseUnrestrictResponse(unrestricted) });
    expect(text).not.toContain(TOKEN);
    const logged = logs.join("\n");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(unrestricted.download);
    expect(logged).not.toContain("ABCDEF");
    expect(logged).not.toContain(LINK);
  });

  it("maps Real-Debrid errors to clear messages without leaking the token", async () => {
    vi.stubEnv("REAL_DEBRID_TOKEN", TOKEN);
    vi.stubGlobal("fetch", fakeFetch(json(503, { error: "hoster_unsupported", error_code: 16 })).impl);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(request({ link: LINK }));
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("unsupported_host");
    expect(text).not.toContain(TOKEN);
  });

  it("answers 503 when the server has no token", async () => {
    vi.stubEnv("REAL_DEBRID_TOKEN", "");
    const res = await POST(request({ link: LINK }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("not_configured");
  });

  it("rejects bad input before calling Real-Debrid", async () => {
    vi.stubEnv("REAL_DEBRID_TOKEN", TOKEN);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const res = await POST(request({ link: "nope" }));
    expect(res.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses cross-site callers", async () => {
    vi.stubEnv("REAL_DEBRID_TOKEN", TOKEN);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await POST(request({ link: LINK }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(request({ link: LINK }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });
});
