import { afterEach, describe, expect, it, vi } from "vitest";
import { browserReach, reachSummary, serverReach, verdict, worthChecking, type Reachability } from "@/lib/media/reachability";

const ok = { result: "ok", status: 206, cors: "allowed" } as const;
const r = (browser: Reachability["browser"], server: Reachability["server"] = ok): Reachability => ({ browser, server });
const NO_CLAIMS = /censor|region|countr|ISP|govern|blocked/i;

describe("verdict", () => {
  it("names a failed connection as the network, never as the format, and claims no cause", () => {
    const v = verdict("FORMAT_UNSUPPORTED", r({ result: "unreachable" }), "cdn.example");
    expect(v.code).toBe("NETWORK_UNREACHABLE");
    expect(v.message).toMatch(/cdn\.example\) couldn't be reached from this device, but the same link answered Watch Party's server/);
    expect(v.message).not.toMatch(NO_CLAIMS);
    expect(v.message).not.toMatch(/compatible/);
  });

  it("says when the server can't reach it either, or when our check couldn't run", () => {
    expect(verdict("UNKNOWN", r({ result: "unreachable" }, { result: "timeout" }), "h").message).toMatch(/^Neither this device nor Watch Party's server/);
    expect(verdict("UNKNOWN", r({ result: "timeout" }, { result: "unavailable" }), "h")).toEqual({
      code: "NETWORK_TIMEOUT",
      message: "The video's server (h) didn't answer this device in time. Check the connection and try again.",
    });
    // An HTTP error on the server still means the server got an answer.
    expect(verdict("UNKNOWN", r({ result: "unreachable" }, { result: "http", status: 403 }), "h").message).toMatch(/answered Watch Party's server/);
  });

  it("reports a status only when this device actually saw it", () => {
    expect(verdict("FORMAT_UNSUPPORTED", r({ result: "http", status: 403 }), "h")).toMatchObject({ code: "HTTP_DENIED", message: expect.stringMatching(/refused this device \(HTTP 403\)/) });
    expect(verdict("FORMAT_UNSUPPORTED", r({ result: "http", status: 451 }), "h").code).toBe("HTTP_DENIED");
    expect(verdict("UNKNOWN", r({ result: "http", status: 410 }), "h").code).toBe("EXPIRED_OR_UNAUTHORIZED");
    expect(verdict("UNKNOWN", r({ result: "http", status: 502 }), "h").code).toBe("SOURCE_UNAVAILABLE");
    for (const s of [403, 451]) expect(verdict("UNKNOWN", r({ result: "http", status: s }), "h").message).not.toMatch(NO_CLAIMS);
  });

  it("confirms a codec failure only when the bytes reached this page", () => {
    expect(verdict("FORMAT_UNSUPPORTED", r({ result: "readable", status: 206 }), "h")).toEqual({ code: "CODEC_UNSUPPORTED", message: null });
    expect(verdict("NETWORK_ERROR", r({ result: "readable", status: 206 }), "h")).toEqual({ code: "NETWORK_ERROR", message: null });
  });

  it("an opaque answer keeps a CORS reason, and stays unknown for a decoder complaint", () => {
    expect(verdict("RANGE_UNSUPPORTED", r({ result: "answered" }), "h")).toEqual({ code: "RANGE_UNSUPPORTED", message: null });
    const cors = { result: "ok", status: 206, cors: "missing" } as const;
    expect(verdict("FORMAT_UNSUPPORTED", r({ result: "answered" }, cors), "h").code).toBe("UNKNOWN");
    // Our server reads it with CORS, this device can't: the answer differs, cause hidden.
    const v = verdict("FORMAT_UNSUPPORTED", r({ result: "answered" }), "h");
    expect(v.code).toBe("UNKNOWN");
    expect(v.message).toMatch(/answered this device differently/);
    expect(v.message).not.toMatch(NO_CLAIMS);
  });

  it("skips failures that are already specific", () => {
    for (const c of ["DRM_LICENSE_REQUIRED", "ENGINE_UNAVAILABLE", "NOT_MEDIA", "EXPIRED_OR_UNAUTHORIZED", "FINAL_CDN_CORS_BLOCKED"] as const) expect(worthChecking(c)).toBe(false);
    for (const c of ["FORMAT_UNSUPPORTED", "RANGE_UNSUPPORTED", "NETWORK_ERROR", "STREAM_START_TIMEOUT", "UNKNOWN", "MSE_MANIFEST"] as const) expect(worthChecking(c)).toBe(true);
  });

  it("summarises without the URL", () => {
    expect(reachSummary(r({ result: "http", status: 403 }))).toEqual({ browser: "http 403", server: "ok 206 cors:allowed" });
  });
});

describe("browserReach", () => {
  afterEach(() => vi.unstubAllGlobals());
  const url = "https://cdn.example/v.mp4?sig=SECRET";

  it("reads one byte with CORS and no credentials, the URL untouched", async () => {
    const fetch = vi.fn(async () => new Response("x", { status: 206 }));
    vi.stubGlobal("fetch", fetch);
    expect(await browserReach(url)).toEqual({ result: "readable", status: 206 });
    expect(fetch).toHaveBeenCalledOnce();
    const [u, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(u).toBe(url);
    expect(init).toMatchObject({ mode: "cors", credentials: "omit", headers: { Range: "bytes=0-0" } });
  });

  it("an error status it can read is reported as such", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    expect(await browserReach(url)).toEqual({ result: "http", status: 403 });
  });

  it("tells a CORS refusal (server answered) from no answer at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        if (init.mode === "cors") throw new TypeError("Load failed");
        return new Response(null, { status: 200 });
      }),
    );
    expect(await browserReach(url)).toEqual({ result: "answered" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Load failed"))));
    expect(await browserReach(url)).toEqual({ result: "unreachable" });
  });

  it("times out instead of hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("t", "TimeoutError"))))),
    );
    expect(await browserReach(url, 20)).toEqual({ result: "timeout" });
  });
});

describe("serverReach", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("asks our header-only resolver and keeps only the outcome", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: false, reason: "http_error", status: 451, originalUrl: "x" }));
    vi.stubGlobal("fetch", fetch);
    expect(await serverReach("https://cdn.example/v.mp4")).toEqual({ result: "http", status: 451 });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("/api/media/resolve");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, reason: "blocked" })));
    expect(await serverReach("http://10.0.0.1/v.mp4")).toEqual({ result: "unavailable" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await serverReach("https://cdn.example/v.mp4")).toEqual({ result: "unavailable" });
  });
});
