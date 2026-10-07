import type { MediaSource, SourceKind } from "@/lib/room/types";
import { NOT_DIRECT_MESSAGE } from "@/lib/media/source";
import { Emitter, notAllowed, type PlayerAdapter, type PlayerListener } from "@/lib/player/types";
import { PositionClock, loadScript } from "@/lib/player/script";
import type { PlayerOptions } from "@/lib/player/html5";

/** The subset of the official IFrame Player API we use. */
type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
};
type YTNamespace = {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
};
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;
const PLAY_TIMEOUT_MS = 3000;
const POLL_MS = 250;

function loadYouTubeApi(): Promise<void> {
  return loadScript(
    "https://www.youtube.com/iframe_api",
    () => Boolean(window.YT?.Player),
    (done) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        done();
      };
    },
  );
}

/** YouTube through the official IFrame Player API. */
export class YouTubePlayerAdapter implements PlayerAdapter {
  readonly kind: SourceKind = "youtube";
  readonly seekLead = 0.3;
  private readonly events = new Emitter();
  private readonly target: HTMLDivElement;
  private readonly wrapper: HTMLDivElement;
  private player: YTPlayer | null = null;
  private isReady = false;
  private state: number = STATE.UNSTARTED;
  private wantPlaying = false;
  private seekingUntil = 0;
  private failure: string | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private clock = new PositionClock();
  private lastSample: { t: number; at: number } | null = null;
  private playWaiters: { resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private destroyed = false;

  constructor(container: HTMLElement, private readonly opts: PlayerOptions) {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "relative aspect-video w-full bg-black";
    this.wrapper.dataset.testid = "provider-player";
    this.wrapper.dataset.provider = "youtube";
    this.target = document.createElement("div");
    this.wrapper.appendChild(this.target);
    if (!opts.controls) this.wrapper.appendChild(clickShield());
    container.appendChild(this.wrapper);
  }

  load(source: MediaSource) {
    this.events.emit("loading");
    void loadYouTubeApi().then(
      () => {
        if (this.destroyed || !window.YT) return;
        const c = this.opts.controls;
        this.player = new window.YT.Player(this.target, {
          videoId: source.videoId ?? "",
          width: "100%",
          height: "100%",
          playerVars: {
            controls: c ? 1 : 0,
            disablekb: c ? 0 : 1,
            fs: c ? 1 : 0,
            playsinline: 1,
            rel: 0,
            iv_load_policy: 3,
            enablejsapi: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              this.isReady = true;
              this.events.emit("ready");
              this.events.emit("canplay");
            },
            onStateChange: (e) => this.onState(e.data),
            // 2 bad id, 5 HTML5 error, 100 removed/private, 101/150 embedding disabled.
            onError: () => this.fail(NOT_DIRECT_MESSAGE),
          },
        });
        const iframe = this.wrapper.querySelector("iframe");
        if (iframe) iframe.className = "absolute inset-0 h-full w-full";
        this.poll = setInterval(() => this.sample(), POLL_MS);
      },
      () => this.fail("Couldn't load the YouTube player."),
    );
  }

  private fail(message: string) {
    if (this.failure) return;
    this.failure = message;
    this.settlePlay(false);
    this.events.emit("error", { message });
  }

  private onState(s: number) {
    this.state = s;
    this.seekingUntil = 0;
    // Re-anchor at every transition so extrapolation starts from the real position.
    if (this.player) this.clock.reset(this.player.getCurrentTime());
    switch (s) {
      case STATE.PLAYING:
        this.wantPlaying = true;
        this.settlePlay(true);
        this.events.emit("play");
        this.events.emit("playing");
        this.events.emit("canplay");
        break;
      case STATE.PAUSED:
        this.wantPlaying = false;
        this.events.emit("pause");
        break;
      case STATE.BUFFERING:
        this.events.emit("waiting");
        break;
      case STATE.ENDED:
        this.wantPlaying = false;
        this.events.emit("pause");
        this.events.emit("ended");
        break;
      case STATE.CUED:
        this.events.emit("canplay");
        break;
    }
  }

  /** The API has no seek event, so detect jumps in position (e.g. the host using YouTube's own controls). */
  private sample() {
    if (!this.player || !this.isReady) return;
    const t = this.player.getCurrentTime();
    this.clock.set(t, this.state === STATE.PLAYING);
    const now = performance.now();
    const prev = this.lastSample;
    this.lastSample = { t, at: now };
    if (!prev || now < this.seekingUntil) return;
    const expected = prev.t + (this.state === STATE.PLAYING ? ((now - prev.at) / 1000) * this.rate() : 0);
    const jump = Math.abs(t - expected);
    if (jump > (this.state === STATE.PLAYING ? 1 : 0.25)) this.events.emit("seeked");
  }

  private settlePlay(ok: boolean) {
    const waiters = this.playWaiters;
    this.playWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      if (ok) w.resolve();
      else w.reject(notAllowed());
    }
  }

  play() {
    if (!this.player) return Promise.reject(new Error("Player not ready"));
    if (this.state === STATE.PLAYING) return Promise.resolve();
    this.wantPlaying = true;
    this.player.playVideo();
    return new Promise<void>((resolve, reject) => {
      // Blocked autoplay leaves the player unstarted or paused instead of rejecting.
      const timer = setTimeout(() => {
        this.playWaiters = this.playWaiters.filter((w) => w.timer !== timer);
        if (this.state === STATE.PLAYING || this.state === STATE.BUFFERING) resolve();
        else {
          this.wantPlaying = false;
          reject(notAllowed());
        }
      }, PLAY_TIMEOUT_MS);
      this.playWaiters.push({ resolve, reject, timer });
    });
  }
  pause() {
    this.wantPlaying = false;
    this.player?.pauseVideo();
  }
  seek(seconds: number) {
    if (!this.player) return;
    // seekTo starts playback from the cued/unstarted state, so pause again if we weren't meant to play.
    const stayPaused = !this.wantPlaying && this.state !== STATE.PLAYING && this.state !== STATE.BUFFERING;
    this.player.seekTo(seconds, true);
    if (stayPaused) this.player.pauseVideo();
    this.clock.reset(seconds);
    this.lastSample = { t: seconds, at: performance.now() };
    this.seekingUntil = performance.now() + 1000;
    setTimeout(() => this.events.emit("seeked"), 0);
  }
  currentTime() {
    if (!this.player) return 0;
    const playing = this.state === STATE.PLAYING;
    this.clock.set(this.player.getCurrentTime(), playing);
    return this.clock.get(playing, this.rate());
  }
  duration() {
    const d = this.player?.getDuration() ?? 0;
    return d > 0 ? d : NaN;
  }
  playing() {
    return this.state === STATE.PLAYING || (this.state === STATE.BUFFERING && this.wantPlaying);
  }
  ended() {
    return this.state === STATE.ENDED;
  }
  ready() {
    return this.isReady && !this.failure;
  }
  canContinue() {
    return this.isReady && this.state !== STATE.BUFFERING;
  }
  seeking() {
    return performance.now() < this.seekingUntil;
  }
  error() {
    return this.failure;
  }
  /** YouTube only offers coarse steps (0.25x), so drift is corrected by seeking instead. */
  setRate(rate: number) {
    if (rate === 1) {
      if (this.player && this.player.getPlaybackRate() !== 1) this.player.setPlaybackRate(1);
      return true;
    }
    return false;
  }
  rate() {
    return this.player?.getPlaybackRate() ?? 1;
  }
  setVolume(volume: number) {
    this.player?.setVolume(Math.round(volume * 100));
  }
  setMuted(muted: boolean) {
    if (muted) this.player?.mute();
    else this.player?.unMute();
  }
  on(listener: PlayerListener) {
    return this.events.on(listener);
  }
  destroy() {
    this.destroyed = true;
    if (this.poll) clearInterval(this.poll);
    this.settlePlay(false);
    this.events.clear();
    this.player?.destroy();
    this.player = null;
    this.wrapper.remove();
  }
}

/** Guests watch, they don't drive: a transparent layer keeps clicks off the provider's own controls. */
export function clickShield(): HTMLDivElement {
  const shield = document.createElement("div");
  shield.className = "absolute inset-0";
  shield.dataset.testid = "click-shield";
  return shield;
}
