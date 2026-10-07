import { describe, expect, it, vi } from "vitest";
import { INCOMPATIBLE_MESSAGE, prefersMovi, resolveSource } from "@/lib/media/source";
import type { MediaSource } from "@/lib/room/types";
import type { PlayerEvent, PlayerListener } from "@/lib/player/types";

/** A scripted stand-in for MediaElementAdapter / MoviPlayerAdapter. */
class FakeAdapter {
  static made: FakeAdapter[] = [];
  readonly seekLead = 0.1;
  listeners = new Set<PlayerListener>();
  loaded: MediaSource | null = null;
  isReady = false;
  t = 0;
  volume = 1;
  muted = false;
  playCalls = 0;
  destroyed = false;
  constructor(readonly engine: "native" | "movi") {
    FakeAdapter.made.push(this);
  }
  emit(e: PlayerEvent, detail?: { message?: string }) {
    for (const l of this.listeners) l(e, detail);
  }
  on(l: PlayerListener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  load(s: MediaSource) {
    this.loaded = s;
  }
  play() {
    this.playCalls++;
    return Promise.resolve();
  }
  pause() {}
  seek(s: number) {
    this.t = s;
  }
  currentTime() {
    return this.t;
  }
  duration() {
    return 100;
  }
  playing() {
    return false;
  }
  ended() {
    return false;
  }
  ready() {
    return this.isReady;
  }
  canContinue() {
    return this.isReady;
  }
  seeking() {
    return false;
  }
  error() {
    return null;
  }
  setRate() {
    return true;
  }
  rate() {
    return 1;
  }
  setVolume(v: number) {
    this.volume = v;
  }
  setMuted(m: boolean) {
    this.muted = m;
  }
  destroy() {
    this.destroyed = true;
  }
}

vi.mock("@/lib/player/media-element", () => ({
  MediaElementAdapter: class extends FakeAdapter {
    constructor() {
      super("native");
    }
  },
}));
vi.mock("@/lib/player/movi", async (orig) => {
  const real = await orig<typeof import("@/lib/player/movi")>();
  return {
    ...real,
    MoviPlayerAdapter: class extends FakeAdapter {
      constructor() {
        super("movi");
      }
    },
  };
});

const { FallbackPlayer, finalMessage, shouldFallBack } = await import("@/lib/player/fallback");
const { RANGE_BLOCKED_MESSAGE, MOVI_INCOMPATIBLE_MESSAGE, classifyMoviError, moviErrorMessage } = await import("@/lib/player/movi");

const file = (url: string, label = "x (host)"): MediaSource => ({ kind: "file", url, label });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Movi routing", () => {
  it.each([
    ["https://cdn.example/Movie.2024.2160p.HEVC.mkv", true],
    ["https://cdn.example/old.avi", true],
    ["https://cdn.example/rec.m2ts", true],
    ["https://cdn.example/rec.ts?token=abc", true],
    ["https://cdn.example/clip.mp4", false],
    ["https://cdn.example/clip.webm", false],
    ["https://cdn.example/download/abc123", false],
  ])("%s → Movi first: %s", (url, want) => {
    expect(prefersMovi(file(url))).toBe(want);
  });

  it("uses the probed file name of an extensionless link", () => {
    expect(prefersMovi(file("https://cdn.example/d/XYZ", "Movie.2024.mkv (cdn.example)"))).toBe(true);
    expect(prefersMovi(file("https://cdn.example/d/XYZ", "Movie.2024.mp4 (cdn.example)"))).toBe(false);
  });

  it("never routes streams or providers to Movi", () => {
    expect(prefersMovi({ kind: "hls", url: "https://a/b.mkv", label: "" })).toBe(false);
    expect(prefersMovi({ kind: "youtube", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", label: "" })).toBe(false);
  });

  it("treats Movi containers as certain direct files", () => {
    for (const ext of ["mkv", "avi", "ts", "m2ts"]) {
      const r = resolveSource(`https://cdn.example/a.${ext}?sig=1`);
      expect(r).toMatchObject({ ok: true, certain: true, source: { kind: "file", url: `https://cdn.example/a.${ext}?sig=1` } });
    }
  });
});

describe("Movi error classification", () => {
  it.each([
    ["Failed to fetch video resource. Check your connection or CORS settings.", "range"],
    ["Server does not support range requests.", "range"],
    ["Video not found.", "missing"],
    ["Access denied. Check video permissions.", "denied"],
    ["Authentication required.", "denied"],
    ["Unsupported codec: vc1", "codec"],
    ["Invalid data found when processing input", "codec"],
  ] as const)("%s → %s", (msg, kind) => {
    expect(classifyMoviError(msg)).toBe(kind);
  });

  it("never echoes the URL back to the viewer", () => {
    for (const k of ["range", "missing", "denied", "codec"] as const) expect(moviErrorMessage(k)).not.toMatch(/https?:/);
  });
});

describe("native ↔ Movi fallback", () => {
  it("falls back from <video> only when it can't decode", () => {
    expect(shouldFallBack("native", INCOMPATIBLE_MESSAGE)).toBe(true);
    expect(shouldFallBack("native", `${INCOMPATIBLE_MESSAGE} No playable video track was found.`)).toBe(true);
    expect(shouldFallBack("native", "Network error while loading the video. Check the link and try again.")).toBe(false);
    expect(shouldFallBack("movi", RANGE_BLOCKED_MESSAGE)).toBe(true);
  });

  it("blames the link when Movi was blocked and <video> can't decode", () => {
    expect(finalMessage({ engine: "movi", message: RANGE_BLOCKED_MESSAGE }, INCOMPATIBLE_MESSAGE)).toBe(RANGE_BLOCKED_MESSAGE);
    expect(finalMessage({ engine: "native", message: INCOMPATIBLE_MESSAGE }, MOVI_INCOMPATIBLE_MESSAGE)).toBe(MOVI_INCOMPATIBLE_MESSAGE);
    const missing = moviErrorMessage("missing");
    expect(finalMessage({ engine: "movi", message: missing }, INCOMPATIBLE_MESSAGE)).toBe(missing);
    expect(finalMessage({ engine: "movi", message: MOVI_INCOMPATIBLE_MESSAGE }, INCOMPATIBLE_MESSAGE)).toBe(INCOMPATIBLE_MESSAGE);
    const network = "Network error while loading the video. Check the link and try again.";
    expect(finalMessage({ engine: "movi", message: missing }, network)).toBe(network);
  });

  it("retries once on Movi with the same URL, position, play state, volume and mute", async () => {
    FakeAdapter.made = [];
    const url = "https://cdn.example/d/abc?sig=AbC%2Bx&exp=1";
    const p = new FallbackPlayer({} as HTMLElement, { controls: false }, ["native", "movi"]);
    const events: string[] = [];
    p.on((e, d) => events.push(d?.message ? `${e}:${d.message}` : e));
    p.load(file(url));
    p.setVolume(0.4);
    p.setMuted(true);
    const native = FakeAdapter.made[0];
    native.isReady = true;
    native.emit("ready");
    void p.play();
    native.t = 1234.5;
    native.emit("error", { message: `${INCOMPATIBLE_MESSAGE} No playable video track was found.` });
    native.emit("ready"); // late event from the failing element is dropped
    await tick();

    expect(native.destroyed).toBe(true);
    expect(p.activeEngine()).toBe("movi");
    const movi = FakeAdapter.made[1];
    expect(movi.loaded?.url).toBe(url);
    expect(p.currentTime()).toBe(1234.5);
    expect(p.playing()).toBe(true);
    movi.isReady = true;
    movi.emit("ready");
    expect(movi.t).toBe(1234.5);
    expect(movi.playCalls).toBe(1);
    expect(movi.volume).toBe(0.4);
    expect(movi.muted).toBe(true);
    expect(events.filter((e) => e.startsWith("error"))).toEqual([]);
    expect(events.filter((e) => e === "ready")).toHaveLength(2);
  });

  it("reports the second failure and doesn't retry again", async () => {
    FakeAdapter.made = [];
    const p = new FallbackPlayer({} as HTMLElement, { controls: true }, ["movi", "native"]);
    const errors: string[] = [];
    p.on((e, d) => e === "error" && errors.push(d?.message ?? ""));
    p.load(file("https://cdn.example/a.mkv"));
    FakeAdapter.made[0].emit("error", { message: RANGE_BLOCKED_MESSAGE });
    await tick();
    expect(p.activeEngine()).toBe("native");
    FakeAdapter.made[1].emit("error", { message: INCOMPATIBLE_MESSAGE });
    await tick();
    expect(FakeAdapter.made).toHaveLength(2);
    expect(errors).toEqual([RANGE_BLOCKED_MESSAGE]);
  });

  it("doesn't switch engines on a network error from <video>", async () => {
    FakeAdapter.made = [];
    const p = new FallbackPlayer({} as HTMLElement, { controls: true }, ["native", "movi"]);
    const errors: string[] = [];
    p.on((e, d) => e === "error" && errors.push(d?.message ?? ""));
    p.load(file("https://cdn.example/a.mp4"));
    FakeAdapter.made[0].emit("error", { message: "Network error while loading the video. Check the link and try again." });
    await tick();
    expect(FakeAdapter.made).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});
