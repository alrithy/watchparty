/**
 * What this browser can play, from feature detection only (never the user
 * agent string). Host and guest each compute their own: the same link can need
 * a different engine on an iPhone than on a desktop. A capability is a hint for
 * routing; actual playback still decides.
 */

export type MseKind = "mse" | "managed" | "none";

export type Capabilities = {
  /** `<video>` claims HLS support (`application/vnd.apple.mpegurl`). */
  nativeHls: boolean;
  /**
   * WebKit's own HLS player (Safari, iOS, Home Screen web apps). It needs no
   * CORS, keeps AirPlay, and is Apple's recommended path, so it goes before hls.js.
   */
  appleNativeHls: boolean;
  /** Media Source Extensions for hls.js/dash.js: classic, Managed (iOS 17.1+), or none. */
  mse: MseKind;
  webCodecs: { video: boolean; audio: boolean };
  wasm: boolean;
  /** Movi can run here: WebAssembly demuxing plus WebCodecs video decoding (it decodes audio in WASM when needed). */
  movi: boolean;
  /** Installed Home Screen / standalone web app. */
  standalone: boolean;
  /** `navigator.audioSession` exists (iOS 17+), which decides whether Web Audio obeys the silent switch. */
  audioSession: boolean;
  touch: boolean;
  /** `<video>.canPlayType` answers for the containers and codecs routing cares about. */
  canPlay: Record<string, "" | "maybe" | "probably">;
};

/** Types asked of `<video>.canPlayType`. Keys are short names used in diagnostics. */
export const CAN_PLAY_TYPES: Record<string, string> = {
  "mp4/h264+aac": 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
  "mp4/hevc(hvc1)": 'video/mp4; codecs="hvc1.1.6.L150.90"',
  "mp4/hevc-main10": 'video/mp4; codecs="hvc1.2.4.L153.B0"',
  "mp4/ac-3": 'audio/mp4; codecs="ac-3"',
  "mp4/e-ac-3": 'audio/mp4; codecs="ec-3"',
  "mp4/av1": 'video/mp4; codecs="av01.0.08M.08"',
  mov: "video/quicktime",
  "webm/vp9": 'video/webm; codecs="vp9, opus"',
  "webm/av1": 'video/webm; codecs="av01.0.08M.08, opus"',
  mkv: "video/x-matroska",
  "mpeg-ts": "video/mp2t",
  hls: "application/vnd.apple.mpegurl",
  dash: "application/dash+xml",
};

/** The globals detection reads; injectable so routing can be tested without a browser. */
export type CapabilityEnv = {
  video?: { canPlayType(type: string): string } | null;
  win?: Record<string, unknown>;
  nav?: Record<string, unknown>;
  matchMedia?: (query: string) => { matches: boolean };
};

function defaultEnv(): CapabilityEnv {
  if (typeof window === "undefined" || typeof document === "undefined") return {};
  return {
    video: document.createElement("video"),
    win: window as unknown as Record<string, unknown>,
    nav: navigator as unknown as Record<string, unknown>,
    matchMedia: typeof window.matchMedia === "function" ? (q) => window.matchMedia(q) : undefined,
  };
}

function answer(v: string): "" | "maybe" | "probably" {
  return v === "maybe" || v === "probably" ? v : "";
}

/** No browser at all (server render): nothing is claimed. */
export const NO_CAPABILITIES: Capabilities = {
  nativeHls: false,
  appleNativeHls: false,
  mse: "none",
  webCodecs: { video: false, audio: false },
  wasm: false,
  movi: false,
  standalone: false,
  audioSession: false,
  touch: false,
  canPlay: {},
};

export function detectCapabilities(env: CapabilityEnv = defaultEnv()): Capabilities {
  const { video, win, nav } = env;
  if (!video || !win) return NO_CAPABILITIES;
  const canPlay: Capabilities["canPlay"] = {};
  for (const [name, type] of Object.entries(CAN_PLAY_TYPES)) {
    try {
      canPlay[name] = answer(video.canPlayType(type));
    } catch {
      canPlay[name] = "";
    }
  }
  const nativeHls = canPlay.hls !== "";
  // WebKit-only media element API: present in Safari on macOS and iOS, absent in Chromium and Firefox.
  const proto = (win.HTMLVideoElement as { prototype?: object } | undefined)?.prototype;
  const webkitVideo = !!proto && "webkitSupportsPresentationMode" in proto;
  const has = (name: string) => typeof win[name] === "function";
  const mse: MseKind = has("ManagedMediaSource") ? "managed" : has("MediaSource") || has("WebKitMediaSource") ? "mse" : "none";
  const webCodecs = { video: has("VideoDecoder"), audio: has("AudioDecoder") };
  const wasm = typeof win.WebAssembly === "object" && win.WebAssembly !== null;
  const standalone =
    nav?.standalone === true || !!env.matchMedia?.("(display-mode: standalone)").matches || !!env.matchMedia?.("(display-mode: fullscreen)").matches;
  return {
    nativeHls,
    appleNativeHls: nativeHls && webkitVideo,
    mse,
    webCodecs,
    wasm,
    movi: wasm && webCodecs.video,
    standalone,
    audioSession: !!nav && "audioSession" in nav,
    touch: typeof nav?.maxTouchPoints === "number" && (nav.maxTouchPoints as number) > 0,
    canPlay,
  };
}

let cached: Capabilities | null = null;

/** This page's capabilities, computed once. */
export function capabilities(): Capabilities {
  if (typeof window === "undefined") return NO_CAPABILITIES;
  cached ??= detectCapabilities();
  return cached;
}

export type DecoderCheck = { name: string; supported: boolean | null; smooth?: boolean; powerEfficient?: boolean };

const VIDEO_CODECS: [string, string, number, number][] = [
  ["H.264 1080p", "avc1.640028", 1920, 1080],
  ["HEVC 1080p", "hvc1.1.6.L120.90", 1920, 1080],
  ["HEVC Main10 4K", "hvc1.2.4.L153.B0", 3840, 2160],
  ["VP9 1080p", "vp09.00.40.08", 1920, 1080],
  ["AV1 1080p", "av01.0.08M.08", 1920, 1080],
];
const AUDIO_CODECS: [string, string][] = [
  ["AAC", "mp4a.40.2"],
  ["AC-3", "ac-3"],
  ["E-AC-3", "ec-3"],
  ["Opus", "opus"],
  ["FLAC", "flac"],
];

type DecoderGlobal = { isConfigSupported(config: object): Promise<{ supported?: boolean }> };
type MediaCaps = { decodingInfo(config: object): Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }> };

/**
 * Slower checks for the diagnostics panel: WebCodecs decoder support and
 * MediaCapabilities' smooth/power-efficient estimates for a file `<video>`.
 * `supported: null` means the API doesn't exist here.
 */
export async function checkDecoders(): Promise<{ webCodecs: DecoderCheck[]; mediaCapabilities: DecoderCheck[] }> {
  const g = globalThis as unknown as { VideoDecoder?: DecoderGlobal; AudioDecoder?: DecoderGlobal };
  const mc = (globalThis.navigator as unknown as { mediaCapabilities?: MediaCaps } | undefined)?.mediaCapabilities;
  const ask = async (dec: DecoderGlobal | undefined, config: object) => {
    if (!dec) return null;
    try {
      return !!(await dec.isConfigSupported(config)).supported;
    } catch {
      return false;
    }
  };
  const webCodecs: DecoderCheck[] = [];
  for (const [name, codec, codedWidth, codedHeight] of VIDEO_CODECS) {
    webCodecs.push({ name: `video ${name}`, supported: await ask(g.VideoDecoder, { codec, codedWidth, codedHeight }) });
  }
  for (const [name, codec] of AUDIO_CODECS) {
    webCodecs.push({ name: `audio ${name}`, supported: await ask(g.AudioDecoder, { codec, sampleRate: 48000, numberOfChannels: 2 }) });
  }
  const mediaCapabilities: DecoderCheck[] = [];
  for (const [name, codec, width, height] of VIDEO_CODECS) {
    if (!mc) {
      mediaCapabilities.push({ name, supported: null });
      continue;
    }
    const container = codec.startsWith("vp09") ? "webm" : "mp4";
    try {
      const r = await mc.decodingInfo({
        type: "file",
        video: { contentType: `video/${container}; codecs="${codec}"`, width, height, bitrate: width > 1920 ? 20_000_000 : 6_000_000, framerate: 24 },
      });
      mediaCapabilities.push({ name, supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient });
    } catch {
      mediaCapabilities.push({ name, supported: false });
    }
  }
  return { webCodecs, mediaCapabilities };
}
