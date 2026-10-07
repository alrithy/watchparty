import { describe, expect, it } from "vitest";
import { decideCorrection, expectedPosition, SEEK_COOLDOWN_MS } from "@/lib/sync/drift";
import { estimateOffset } from "@/lib/sync/clock";
import { generateRoomId, isValidRoomId, normalizeRoomId } from "@/lib/room/id";
import { labelFor, resolveSource } from "@/lib/media/source";
import type { PlaybackState } from "@/lib/room/types";

const state = (p: Partial<PlaybackState>): PlaybackState => ({
  playing: true,
  positionSeconds: 10,
  refTime: 1_000_000,
  revision: 1,
  hostId: "h",
  ...p,
});

describe("expectedPosition", () => {
  it("extrapolates while playing", () => {
    expect(expectedPosition(state({}), 1_002_500)).toBeCloseTo(12.5);
  });
  it("holds while paused", () => {
    expect(expectedPosition(state({ playing: false }), 1_009_000)).toBe(10);
  });
  it("clamps to duration and never goes negative", () => {
    expect(expectedPosition(state({}), 1_100_000, 20)).toBe(20);
    expect(expectedPosition(state({ positionSeconds: 0 }), 999_000)).toBe(0);
  });
});

describe("decideCorrection", () => {
  const long = SEEK_COOLDOWN_MS + 1;
  it("ignores small drift", () => {
    expect(decideCorrection(0.2, false, long)).toEqual({ action: "none", rate: 1 });
    expect(decideCorrection(-0.34, false, long).action).toBe("none");
  });
  it("slows down when ahead and speeds up when behind", () => {
    const ahead = decideCorrection(0.6, false, long);
    const behind = decideCorrection(-0.6, false, long);
    expect(ahead.action).toBe("rate");
    expect(ahead.rate).toBeLessThan(1);
    expect(ahead.rate).toBeGreaterThanOrEqual(0.95);
    expect(behind.rate).toBeGreaterThan(1);
    expect(behind.rate).toBeLessThanOrEqual(1.05);
  });
  it("keeps correcting until settled (hysteresis)", () => {
    expect(decideCorrection(0.2, true, long).action).toBe("rate");
    expect(decideCorrection(0.05, true, long).action).toBe("none");
  });
  it("hard seeks on large drift", () => {
    expect(decideCorrection(2, false, long).action).toBe("seek");
    expect(decideCorrection(-1.3, false, long).action).toBe("seek");
  });
  it("does not seek again inside the cooldown", () => {
    const c = decideCorrection(3, false, 500);
    expect(c.action).toBe("rate");
  });
});

describe("estimateOffset", () => {
  it("uses the lowest-RTT sample", () => {
    const { offset, rtt } = estimateOffset([
      { sentAt: 0, receivedAt: 400, serverTime: 5_300 },
      { sentAt: 1000, receivedAt: 1040, serverTime: 6_020 },
    ]);
    expect(rtt).toBe(40);
    // server 6020 at local midpoint 1020 -> offset 5000
    expect(offset).toBe(5000);
  });
  it("returns zero offset without samples", () => {
    expect(estimateOffset([]).offset).toBe(0);
  });
});

describe("room ids", () => {
  it("generates valid codes", () => {
    for (let i = 0; i < 50; i++) expect(isValidRoomId(generateRoomId())).toBe(true);
  });
  it("normalizes codes and invite links", () => {
    expect(normalizeRoomId(" f8k2q9 ")).toBe("F8K2Q9");
    expect(normalizeRoomId("https://x.vercel.app/room/F8K2Q9")).toBe("F8K2Q9");
    expect(normalizeRoomId("nope")).toBeNull();
  });
});

describe("media urls", () => {
  it("validates http(s) only", () => {
    expect(resolveSource("https://a.com/x.mp4").ok).toBe(true);
    expect(resolveSource("javascript:alert(1)").ok).toBe(false);
    expect(resolveSource("not a url").ok).toBe(false);
  });
  it("labels without query strings", () => {
    expect(labelFor("https://cdn.example.com/dl/Movie%20One.mp4?token=secret")).toBe(
      "Movie One.mp4 (cdn.example.com)",
    );
  });
});
