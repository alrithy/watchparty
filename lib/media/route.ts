import type { MediaSource } from "@/lib/room/types";
import type { Capabilities } from "@/lib/media/capabilities";
import { prefersMovi } from "@/lib/media/source";

/**
 * The engines one device may use. `native` is a plain <video> (files, and HLS
 * where the browser plays it itself); `hlsjs`/`dashjs` are the media-element
 * wrappers around hls.js and dash.js; `movi` is the WASM + WebCodecs decoder.
 */
export type Engine = "native" | "hlsjs" | "dashjs" | "movi" | "youtube" | "vimeo";

export type PlaybackPlan = {
  /** Tried in order, switching at most once (locally) on failure. Empty: nothing here can play it. */
  engines: Engine[];
  /** One short line per decision, shown in diagnostics. */
  reasons: string[];
  /** What to tell the viewer when `engines` is empty. */
  unsupported?: string;
};

export type Routing = "smart" | "legacy";

/** MIME types of containers <video> can't be trusted with (same family as the MKV/AVI extensions). */
const MOVI_MIME = /^video\/(x-matroska|x-msvideo|avi|msvideo|mp2t|x-flv|x-ms-wmv|x-ms-asf|vnd\.dlna\.mpeg-tts)$/i;

export function moviContentType(mime: string | undefined): boolean {
  return !!mime && MOVI_MIME.test(mime.split(";")[0].trim());
}

/** The routing before Milestone 4, kept behind `?routing=legacy` for side-by-side device tests. */
function legacyPlan(source: MediaSource): PlaybackPlan {
  switch (source.kind) {
    case "file":
      return { engines: prefersMovi(source) ? ["movi", "native"] : ["native", "movi"], reasons: ["legacy routing"] };
    case "hls":
      return { engines: ["hlsjs"], reasons: ["legacy routing"] };
    case "dash":
      return { engines: ["dashjs"], reasons: ["legacy routing"] };
    default:
      return { engines: [source.kind], reasons: ["legacy routing"] };
  }
}

/**
 * Picks the engines for one source on this device. The URL, the probed file
 * name and content type say what the media is; capabilities say what this
 * browser has. Playback still has the last word: the player switches once if
 * the first engine fails.
 */
export function planPlayback(source: MediaSource, caps: Capabilities, routing: Routing = "smart"): PlaybackPlan {
  if (routing === "legacy") return legacyPlan(source);
  const reasons: string[] = [];
  switch (source.kind) {
    case "youtube":
    case "vimeo":
      return { engines: [source.kind], reasons: [`${source.kind} provider player`] };

    case "hls": {
      const engines: Engine[] = [];
      if (caps.appleNativeHls) {
        engines.push("native");
        reasons.push("Safari's own HLS player first: no CORS needed, AirPlay and Apple codecs");
        if (caps.mse !== "none") {
          engines.push("hlsjs");
          reasons.push("hls.js as fallback");
        }
      } else if (caps.mse !== "none") {
        engines.push("hlsjs");
        reasons.push(`hls.js on ${caps.mse === "managed" ? "Managed Media Source" : "Media Source Extensions"}`);
        if (caps.nativeHls) {
          engines.push("native");
          reasons.push("browser HLS as fallback");
        }
      } else if (caps.nativeHls) {
        engines.push("native");
        reasons.push("browser HLS (no Media Source here)");
      }
      if (!engines.length) {
        return { engines, reasons: ["no HLS support detected"], unsupported: "This browser can't play HLS streams." };
      }
      return { engines, reasons };
    }

    case "dash":
      if (caps.mse === "none") {
        return {
          engines: [],
          reasons: ["DASH needs Media Source Extensions, which this browser lacks"],
          unsupported: "This browser can't play DASH streams. On iPhone, DASH needs iOS 17.1 or later.",
        };
      }
      return { engines: ["dashjs"], reasons: [`dash.js on ${caps.mse === "managed" ? "Managed Media Source" : "Media Source Extensions"}`] };

    case "file": {
      const byName = prefersMovi(source);
      const byType = moviContentType(source.mime);
      const moviFirst = byName || byType;
      if (moviFirst) reasons.push(byName ? "container needs the fallback decoder (from file name)" : `container needs the fallback decoder (${source.mime})`);
      else reasons.push("browser-native container first");
      if (!caps.movi) {
        reasons.push("fallback decoder unavailable here (needs WebAssembly and WebCodecs)");
        return { engines: ["native"], reasons };
      }
      return { engines: moviFirst ? ["movi", "native"] : ["native", "movi"], reasons };
    }
  }
}

/** `?routing=legacy` switches this device back to the pre-Milestone-4 routing. */
export function routingFromLocation(): Routing {
  if (typeof window === "undefined") return "smart";
  try {
    return new URLSearchParams(window.location.search).get("routing") === "legacy" ? "legacy" : "smart";
  } catch {
    return "smart";
  }
}
