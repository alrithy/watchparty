import { describe, expect, it } from "vitest";
import { activeCues, cleanCueText, decodeSubtitleBytes, parseSrt } from "@/lib/subtitles/parse";
import { packText, unpackText } from "@/lib/subtitles/pack";

const SRT = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>مرحبا</i>\r\nبالعالم\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n{\\an8}Hello &amp; bye\r\n";

describe("subtitles", () => {
  it("parses SRT with a BOM, CRLF, markup and Arabic", () => {
    expect(parseSrt(SRT)).toEqual([
      { start: 1, end: 2.5, text: "مرحبا\nبالعالم" },
      { start: 3, end: 4, text: "Hello & bye" },
    ]);
  });

  it("strips VTT voice and style tags", () => {
    expect(cleanCueText("<v Bob>Hi</v> <b>there</b>")).toBe("Hi there");
  });

  it("finds the cues showing at a time", () => {
    const cues = parseSrt(SRT);
    expect(activeCues(cues, 0.5)).toEqual([]);
    expect(activeCues(cues, 2)).toEqual(["مرحبا\nبالعالم"]);
    expect(activeCues(cues, 2.6)).toEqual([]);
    expect(activeCues(cues, 3.5)).toEqual(["Hello & bye"]);
  });

  it("reads Windows-1256 Arabic files", () => {
    // "سلام" in Windows-1256.
    const bytes = new Uint8Array([0xd3, 0xe1, 0xc7, 0xe3]);
    expect(decodeSubtitleBytes(bytes.buffer)).toBe("سلام");
    expect(decodeSubtitleBytes(new TextEncoder().encode("سلام").buffer as ArrayBuffer)).toBe("سلام");
  });

  it("packs subtitles small enough for a room message and back", async () => {
    const big = SRT.repeat(500);
    const packed = await packText(big);
    expect(packed.length).toBeLessThan(big.length / 5);
    expect(await unpackText(packed)).toBe(big);
  });
});
