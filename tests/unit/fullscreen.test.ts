import { describe, expect, it, vi } from "vitest";
import { lockScroll, pickFullscreenMode } from "@/lib/fullscreen";
import { nativeCues } from "@/lib/subtitles/native";

const fn = () => () => Promise.resolve();

describe("pickFullscreenMode", () => {
  it("uses the Fullscreen API on desktop browsers", () => {
    expect(pickFullscreenMode({ requestFullscreen: fn() }, { fullscreenEnabled: true })).toBe("standard");
  });

  it("uses the prefixed API on older WebKit (iPad, older Safari)", () => {
    expect(pickFullscreenMode({ webkitRequestFullscreen: () => {} }, { webkitFullscreenEnabled: true })).toBe("webkit");
  });

  it("uses immersive mode on iPhone, where only the bare <video> can go fullscreen", () => {
    // iPhone Safari: no element fullscreen, the methods may exist but are disabled.
    expect(pickFullscreenMode({}, {})).toBe("immersive");
    expect(
      pickFullscreenMode(
        { requestFullscreen: fn(), webkitRequestFullscreen: () => {} },
        { fullscreenEnabled: false, webkitFullscreenEnabled: false },
      ),
    ).toBe("immersive");
  });
});

describe("lockScroll", () => {
  const page = () => {
    const doc = { documentElement: { style: { overflow: "auto" } as Record<string, string> }, body: { style: { position: "static" } as Record<string, string> } };
    const win = { scrollX: 0, scrollY: 420, scrollTo: vi.fn() };
    return { doc, win };
  };

  it("pins the page at its scroll offset and restores it on unlock", () => {
    const { doc, win } = page();
    const unlock = lockScroll(doc, win);
    expect(doc.documentElement.style.overflow).toBe("hidden");
    expect(doc.body.style).toMatchObject({ overflow: "hidden", position: "fixed", top: "-420px", width: "100%" });

    unlock();
    expect(doc.documentElement.style.overflow).toBe("auto");
    expect(doc.body.style.position).toBe("static");
    expect(doc.body.style.top).toBeUndefined();
    expect(win.scrollTo).toHaveBeenCalledWith(0, 420);
  });

  it("unlocks only once", () => {
    const { doc, win } = page();
    const unlock = lockScroll(doc, win);
    unlock();
    unlock();
    expect(win.scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe("nativeCues", () => {
  const cues = [
    { start: 0, end: 2, text: "مرحبا" },
    { start: 5, end: 8, text: "a < b & c" },
  ];

  it("moves cues by the shared subtitle delay, like the overlay", () => {
    expect(nativeCues(cues, 0.5)).toEqual([
      { start: 0.5, end: 2.5, text: "مرحبا" },
      { start: 5.5, end: 8.5, text: "a &lt; b &amp; c" },
    ]);
  });

  it("drops cues that end before the video starts and clamps the rest", () => {
    expect(nativeCues(cues, -3)).toEqual([{ start: 2, end: 5, text: "a &lt; b &amp; c" }]);
    expect(nativeCues(cues, -1)[0]).toEqual({ start: 0, end: 1, text: "مرحبا" });
  });
});
