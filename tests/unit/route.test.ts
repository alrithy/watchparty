import { describe, expect, it } from "vitest";
import { detectCapabilities, NO_CAPABILITIES, type Capabilities, type CapabilityEnv } from "@/lib/media/capabilities";
import { moviContentType, planPlayback } from "@/lib/media/route";
import { classifyFailure } from "@/lib/media/errors";
import { playbackDiagnostics, reportText, safeExtension, safeHost, safeMessage } from "@/lib/media/diagnostics";
import { DRM_MESSAGE, INCOMPATIBLE_MESSAGE, NOT_DIRECT_MESSAGE } from "@/lib/media/source";
import { MOVI_INCOMPATIBLE_MESSAGE, RANGE_BLOCKED_MESSAGE, moviErrorMessage } from "@/lib/player/movi";
import { finalCdnBlockedMessage } from "@/lib/media/refine";
import { classify } from "@/lib/media/probe";
import type { MediaSource } from "@/lib/room/types";

const fn = () => {};

/** A browser as feature detection sees it. */
function env(opts: { types: Record<string, string>; globals: string[]; webkit?: boolean; nav?: Record<string, unknown>; standalone?: boolean }): CapabilityEnv {
  const win: Record<string, unknown> = { WebAssembly: {}, HTMLVideoElement: { prototype: opts.webkit ? { webkitSupportsPresentationMode: fn } : {} } };
  for (const g of opts.globals) win[g] = fn;
  return {
    video: { canPlayType: (t) => opts.types[t] ?? "" },
    win,
    nav: { maxTouchPoints: 0, ...opts.nav },
    matchMedia: (q) => ({ matches: !!opts.standalone && q.includes("standalone") }),
  };
}

const HLS = "application/vnd.apple.mpegurl";
// iPhone, iOS 17.4+: native HLS, Managed Media Source, VideoDecoder, no AudioDecoder (iOS < 26).
const iphone = detectCapabilities(
  env({
    types: { [HLS]: "maybe", 'video/mp4; codecs="hvc1.1.6.L150.90"': "probably", 'audio/mp4; codecs="ac-3"': "maybe" },
    globals: ["ManagedMediaSource", "VideoDecoder"],
    webkit: true,
    nav: { maxTouchPoints: 5, audioSession: {} },
    standalone: true,
  }),
);
// iPhone before iOS 17.1: native HLS only.
const oldIphone = detectCapabilities(env({ types: { [HLS]: "maybe" }, globals: [], webkit: true }));
const chrome = detectCapabilities(env({ types: {}, globals: ["MediaSource", "VideoDecoder", "AudioDecoder"] }));
// Chromium with native HLS (recent Android/desktop builds): still not WebKit.
const chromeNativeHls = detectCapabilities(env({ types: { [HLS]: "maybe" }, globals: ["MediaSource", "VideoDecoder", "AudioDecoder"] }));

const src = (kind: MediaSource["kind"], url: string, extra: Partial<MediaSource> = {}): MediaSource => ({ kind, url, label: "x (host)", ...extra });

describe("capability detection", () => {
  it("recognises an iPhone Home Screen app from features alone", () => {
    expect(iphone).toMatchObject({
      nativeHls: true,
      appleNativeHls: true,
      mse: "managed",
      webCodecs: { video: true, audio: false },
      movi: true,
      standalone: true,
      audioSession: true,
      touch: true,
    });
    expect(iphone.canPlay["mp4/hevc(hvc1)"]).toBe("probably");
    expect(iphone.canPlay.mkv).toBe("");
  });

  it("doesn't call Chromium's native HLS Apple's", () => {
    expect(chromeNativeHls).toMatchObject({ nativeHls: true, appleNativeHls: false, mse: "mse" });
  });

  it("claims nothing without a browser", () => {
    expect(detectCapabilities({})).toEqual(NO_CAPABILITIES);
  });
});

describe("planPlayback", () => {
  it("plays HLS with Safari's own player first, hls.js second", () => {
    expect(planPlayback(src("hls", "https://cdn.example/master.m3u8"), iphone).engines).toEqual(["native", "hlsjs"]);
    expect(planPlayback(src("hls", "https://cdn.example/master.m3u8"), oldIphone).engines).toEqual(["native"]);
  });

  it("keeps hls.js first elsewhere, with browser HLS as fallback where it exists", () => {
    expect(planPlayback(src("hls", "https://cdn.example/a.m3u8"), chrome).engines).toEqual(["hlsjs"]);
    expect(planPlayback(src("hls", "https://cdn.example/a.m3u8"), chromeNativeHls).engines).toEqual(["hlsjs", "native"]);
  });

  it("refuses DASH up front where there is no Media Source", () => {
    const plan = planPlayback(src("dash", "https://cdn.example/a.mpd"), oldIphone);
    expect(plan.engines).toEqual([]);
    expect(plan.unsupported).toMatch(/iOS 17\.1/);
    expect(planPlayback(src("dash", "https://cdn.example/a.mpd"), iphone).engines).toEqual(["dashjs"]);
  });

  it("starts MKV-family files on Movi, by extension, probed name or content type", () => {
    expect(planPlayback(src("file", "https://cdn.example/a.mkv"), chrome).engines).toEqual(["movi", "native"]);
    expect(planPlayback(src("file", "https://cdn.example/d/XYZ", { label: "Movie.avi (cdn.example)" }), chrome).engines).toEqual(["movi", "native"]);
    expect(planPlayback(src("file", "https://cdn.example/d/XYZ", { mime: "video/x-matroska" }), chrome).engines).toEqual(["movi", "native"]);
    expect(planPlayback(src("file", "https://cdn.example/a.mp4"), chrome).engines).toEqual(["native", "movi"]);
    expect(planPlayback(src("file", "https://cdn.example/d/XYZ", { mime: "video/mp4" }), chrome).engines).toEqual(["native", "movi"]);
  });

  it("never loads Movi where it can't run", () => {
    const plan = planPlayback(src("file", "https://cdn.example/a.mkv"), oldIphone);
    expect(plan.engines).toEqual(["native"]);
    expect(plan.reasons.join(" ")).toMatch(/unavailable/);
  });

  it("leaves YouTube and Vimeo to their providers", () => {
    expect(planPlayback(src("youtube", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"), iphone).engines).toEqual(["youtube"]);
    expect(planPlayback(src("vimeo", "https://vimeo.com/76979871"), iphone).engines).toEqual(["vimeo"]);
  });

  it("can switch back to the old routing for side-by-side tests", () => {
    expect(planPlayback(src("hls", "https://cdn.example/a.m3u8"), iphone, "legacy").engines).toEqual(["hlsjs"]);
    expect(planPlayback(src("file", "https://cdn.example/a.mkv"), oldIphone, "legacy").engines).toEqual(["movi", "native"]);
    expect(planPlayback(src("dash", "https://cdn.example/a.mpd"), oldIphone, "legacy").engines).toEqual(["dashjs"]);
  });

  it("recognises container MIME types with parameters", () => {
    expect(moviContentType("video/x-matroska; charset=binary")).toBe(true);
    expect(moviContentType("video/mp2t")).toBe(true);
    expect(moviContentType("video/mp4")).toBe(false);
    expect(moviContentType(undefined)).toBe(false);
  });
});

describe("error codes", () => {
  it.each([
    ["native", `${INCOMPATIBLE_MESSAGE} No playable video track was found.`, null, "VIDEO_UNSUPPORTED"],
    ["native", INCOMPATIBLE_MESSAGE, null, "FORMAT_UNSUPPORTED"],
    ["hlsjs", INCOMPATIBLE_MESSAGE, null, "MSE_MANIFEST"],
    ["movi", MOVI_INCOMPATIBLE_MESSAGE, null, "FORMAT_UNSUPPORTED"],
    ["movi", RANGE_BLOCKED_MESSAGE, null, "RANGE_UNSUPPORTED"],
    ["movi", finalCdnBlockedMessage("cdn.example", false), "FINAL_CDN_CORS_BLOCKED", "FINAL_CDN_CORS_BLOCKED"],
    ["movi", finalCdnBlockedMessage("cdn.example", true), null, "FINAL_CDN_CORS_BLOCKED"],
    ["movi", moviErrorMessage("missing"), null, "EXPIRED_OR_UNAUTHORIZED"],
    ["movi", moviErrorMessage("denied"), null, "EXPIRED_OR_UNAUTHORIZED"],
    ["native", "Network error while loading the video. Check the link and try again.", null, "NETWORK_ERROR"],
    ["hlsjs", "Network error while loading the stream.", null, "NETWORK_ERROR"],
    ["dashjs", DRM_MESSAGE, null, "DRM_LICENSE_REQUIRED"],
    ["youtube", NOT_DIRECT_MESSAGE, null, "NETWORK_TIMEOUT"],
    ["movi", "Couldn't load the video decoder.", null, "ENGINE_UNAVAILABLE"],
  ] as const)("%s: %s -> %s", (engine, message, reason, code) => {
    expect(classifyFailure(engine, message, reason)).toBe(code);
  });
});

describe("diagnostics never keep URLs", () => {
  const secret = "https://torrentio.example/resolve/realdebrid/APIKEY123/abc/Silo.S03E01.mkv?token=SECRET";

  it("keeps only the host name and extension", () => {
    expect(safeHost(secret)).toBe("torrentio.example");
    expect(safeExtension(secret)).toBe("mkv");
    expect(safeExtension("https://cdn.example/d/XYZ", "Movie.2024.mp4 (cdn.example)")).toBe("mp4");
    expect(safeExtension("https://cdn.example/d/XYZ")).toBeNull();
  });

  it("records attempts and drops writes from a replaced source", () => {
    const caps: Capabilities = iphone;
    const plan = planPlayback(src("file", secret, { label: "Silo.S03E01.mkv (torrentio.example)" }), caps);
    const old = playbackDiagnostics.begin(src("file", secret), plan, caps, "smart");
    const s = playbackDiagnostics.begin(src("file", secret, { label: "Silo.S03E01.mkv (torrentio.example)" }), plan, caps, "smart");
    s.attempt("movi");
    s.failed("RANGE_UNSUPPORTED", RANGE_BLOCKED_MESSAGE);
    s.attempt("native");
    s.ready({ width: 1920, height: 1080, duration: 3000 });
    s.playing();
    old.failed("UNKNOWN", "late write from the previous source");
    const r = playbackDiagnostics.snapshot()!;
    expect(r.attempts.map((a) => [a.engine, a.outcome, a.code])).toEqual([
      ["movi", "failed", "RANGE_UNSUPPORTED"],
      ["native", "playing", undefined],
    ]);
    const text = reportText(r);
    expect(text).not.toMatch(/APIKEY123|SECRET|Silo|resolve\/realdebrid/);
    expect(text).toContain("torrentio.example");
  });
});

describe("diagnostics scrub any error text", () => {
  it.each([
    "Failed to fetch https://abc.download.real-debrid.com/d/ABCDEF123/Silo.S03E01.mkv?token=SECRET",
    "GET //cdn.example/resolve/realdebrid/APIKEY123/xyz failed",
    "manifest error at www.example.com/hls/SECRET/master.m3u8",
    "segment 4 failed (sig=SECRET&exp=1760000000)",
    "redirect to http://10.0.0.1:8080/x?api_key=SECRET",
  ])("%s", (raw) => {
    const out = safeMessage(raw);
    expect(out).not.toMatch(/SECRET|APIKEY123|ABCDEF123|Silo|real-debrid\.com\/d/);
  });

  it("keeps our own sentences intact and caps length", () => {
    expect(safeMessage(INCOMPATIBLE_MESSAGE)).toBe(INCOMPATIBLE_MESSAGE);
    expect(safeMessage(finalCdnBlockedMessage("cdn.example", false))).toBe(finalCdnBlockedMessage("cdn.example", false));
    expect(safeMessage("too long ".repeat(100))).toHaveLength(300);
  });

  it("never stores a URL an engine put in its error", () => {
    const s = playbackDiagnostics.begin(src("file", "https://cdn.example/a.mp4"), { engines: ["native"], reasons: [] }, chrome, "smart");
    s.attempt("native");
    s.failed("UNKNOWN", "Decoder error for https://cdn.example/a.mp4?token=SECRET", true);
    const text = reportText(playbackDiagnostics.snapshot()!);
    expect(text).not.toContain("SECRET");
    expect(playbackDiagnostics.snapshot()!.error).toMatchObject({ code: "UNKNOWN" });
  });

  it("records a source no engine here can play, with no attempt", () => {
    const plan = planPlayback(src("dash", "https://cdn.example/a.mpd"), oldIphone);
    const s = playbackDiagnostics.begin(src("dash", "https://cdn.example/a.mpd"), plan, oldIphone, "smart");
    s.unavailable(plan.unsupported!);
    const r = playbackDiagnostics.snapshot()!;
    expect(r.attempts).toEqual([]);
    expect(r.error).toEqual({ code: "ENGINE_UNAVAILABLE", message: plan.unsupported });
  });
});

describe("picture size in diagnostics", () => {
  it("stays unknown at metadata and fills in once frames play", () => {
    const s = playbackDiagnostics.begin(src("hls", "https://cdn.example/master.m3u8"), { engines: ["hlsjs"], reasons: [] }, iphone, "smart");
    s.attempt("hlsjs");
    s.ready({ duration: 1800, audioTracks: 3, videoCodec: "avc1.640015" });
    expect(playbackDiagnostics.snapshot()!.attempts[0].media).not.toHaveProperty("width");
    s.playing({ width: 1920, height: 1080, duration: 1800, audioTracks: 3, videoCodec: "avc1.640015" });
    expect(playbackDiagnostics.snapshot()!.attempts[0]).toMatchObject({ outcome: "playing", media: { width: 1920, height: 1080 } });
  });
});

describe("createPlayer without a usable engine", () => {
  it("fails with the plan's reason and records it", async () => {
    const el = () => ({ className: "", dataset: {} as Record<string, string>, remove() {}, appendChild() {} });
    const g = globalThis as unknown as { document?: unknown };
    const had = g.document;
    g.document = { createElement: el };
    try {
      const { createPlayer } = await import("@/lib/player/create");
      const p = createPlayer(src("dash", "https://cdn.example/a.mpd?sig=SECRET"), el() as unknown as HTMLElement, { controls: false }, oldIphone, "smart");
      const errors: string[] = [];
      p.on((e, d) => e === "error" && errors.push(d?.message ?? ""));
      p.load(src("dash", "https://cdn.example/a.mpd"));
      await new Promise((r) => setTimeout(r, 0));
      expect(errors[0]).toMatch(/can't play DASH/);
      expect(p.error()).toMatch(/iOS 17\.1/);
      expect(playbackDiagnostics.snapshot()!.error?.code).toBe("ENGINE_UNAVAILABLE");
      expect(reportText(playbackDiagnostics.snapshot()!)).not.toContain("SECRET");
      p.destroy();
    } finally {
      g.document = had;
    }
  });
});

describe("probe content type", () => {
  it("returns a bare media type for routing, never parameters or non-media types", () => {
    expect(classify("video/x-matroska; foo=bar", null)).toMatchObject({ result: "playable", kind: "file", contentType: "video/x-matroska" });
    expect(classify("application/octet-stream", 'attachment; filename="a.mkv"')).toMatchObject({ contentType: "application/octet-stream" });
    expect(classify("text/html", null)).not.toHaveProperty("contentType");
  });
});
