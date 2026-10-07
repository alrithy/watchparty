import { readFileSync } from "node:fs";
import { expect, test as base, type Browser, type BrowserContext, type Page } from "@playwright/test";

const CLIP = "/__test__/clip.webm";

const TYPES: Record<string, string> = {
  webm: "video/webm",
  mp4: "video/mp4",
  m3u8: "application/vnd.apple.mpegurl",
  mpd: "application/dash+xml",
  m4s: "video/iso.segment",
};

/**
 * YouTube and Vimeo are unreachable from the test sandbox, so their official
 * script URLs are answered with stand-ins that implement the same API on top of
 * the test clip. Remote runs also serve the (undeployed) test media from disk,
 * with Range support, which seeking needs. Browser errors are reported.
 */
async function prepareContext(ctx: BrowserContext) {
  ctx.on("weberror", (e) => console.log(`[browser error] ${e.error().message}`));
  ctx.on("console", (m) => {
    if (m.type() === "error") console.log(`[console.error] ${m.text()}`);
  });
  if (!process.env.E2E_REAL_PROVIDERS) {
    await ctx.route("https://www.youtube.com/iframe_api", (route) =>
      route.fulfill({ path: "tests/e2e/fakes/youtube-iframe-api.js", contentType: "text/javascript" }),
    );
    await ctx.route("https://player.vimeo.com/api/player.js", (route) =>
      route.fulfill({ path: "tests/e2e/fakes/vimeo-player.js", contentType: "text/javascript" }),
    );
  }
  if (!process.env.E2E_BASE_URL) return;
  await ctx.route("**/__test__/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let file: Buffer;
    try {
      file = readFileSync(`public${decodeURIComponent(path)}`);
    } catch {
      return route.fulfill({ status: 404 });
    }
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : file.length - 1;
    const ext = /\.(\w+)$/.exec(path)?.[1] ?? "";
    return route.fulfill({
      status: range ? 206 : 200,
      body: file.subarray(start, end + 1),
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.length}` } : {}),
      },
    });
  });
}

const test = base.extend({
  context: async ({ context }, provide) => {
    await prepareContext(context);
    await provide(context);
  },
});

/** A second, independent browser context (another "device"), prepared like the default one. */
async function newContext(browser: Browser) {
  const ctx = await browser.newContext({ storageState: test.info().project.use.storageState });
  await prepareContext(ctx);
  return ctx;
}

type VideoInfo = { t: number; paused: boolean; rate: number; ready: number };

/**
 * With the real YouTube/Vimeo players the <video> sits in a cross-origin iframe,
 * so live runs read and drive the app's active PlayerAdapter instead.
 */
const VIA_ADAPTER = Boolean(process.env.E2E_REAL_PROVIDERS);
type Adapter = {
  currentTime(): number;
  playing(): boolean;
  rate(): number;
  ready(): boolean;
  canContinue(): boolean;
  play(): Promise<void>;
  pause(): void;
  seek(s: number): void;
};

const info = (page: Page): Promise<VideoInfo> =>
  VIA_ADAPTER
    ? page.evaluate(() => {
        const p = (window as unknown as { __watchparty?: { player(): Adapter | null } }).__watchparty?.player();
        if (!p) return { t: 0, paused: true, rate: 1, ready: 0 };
        return { t: p.currentTime(), paused: !p.playing(), rate: p.rate(), ready: p.ready() ? (p.canContinue() ? 4 : 1) : 0 };
      })
    : page.locator('[data-testid="video"]').evaluate((v: HTMLVideoElement): VideoInfo => ({
        t: v.currentTime,
        paused: v.paused,
        rate: v.playbackRate,
        ready: v.readyState,
      }));

/** Play/pause/seek like a person using the player's own controls. */
async function act(page: Page, action: "play" | "pause" | { seek: number } | { nudge: number }) {
  if (VIA_ADAPTER) {
    await page.evaluate((a) => {
      const p = (window as unknown as { __watchparty?: { player(): Adapter | null } }).__watchparty?.player();
      if (!p) throw new Error("no player");
      if (a === "play") void p.play().catch(() => {});
      else if (a === "pause") p.pause();
      else if ("seek" in a) p.seek(a.seek);
      else p.seek(p.currentTime() + a.nudge);
    }, action);
    return;
  }
  await page.locator('[data-testid="video"]').evaluate((v: HTMLVideoElement, a) => {
    if (a === "play") void v.play();
    else if (a === "pause") v.pause();
    else if ("seek" in a) v.currentTime = a.seek;
    else v.currentTime += a.nudge;
  }, action);
}

/** Sample both tabs back to back and return host - guest. */
async function gap(host: Page, guest: Page) {
  const [h, g] = await Promise.all([info(host), info(guest)]);
  return h.t - g.t;
}

/** Connected over the transport this run expects (Supabase Realtime when E2E_SUPABASE is set). */
async function expectTransport(page: Page) {
  const badge = page.getByTestId("connection");
  await expect(badge).toHaveAttribute("data-status", "connected", { timeout: 15_000 });
  if (process.env.E2E_SUPABASE) await expect(badge).not.toContainText("local");
  else await expect(badge).toContainText("local");
}

const video = (page: Page) => page.locator('[data-testid="video"]');

test("host and guest stay in sync across play, pause, seek, drift and reloads", async ({ context }) => {
  const host = await context.newPage();
  await host.goto("/");
  await host.getByTestId("create-room").click();
  await host.waitForURL(/\/room\/[A-Z0-9]{6}$/);
  const roomUrl = new URL(host.url()).pathname;
  await expectTransport(host);

  await host.getByTestId("source-url").fill(new URL(CLIP, host.url()).toString());
  await host.getByTestId("load-source").click();
  await expect.poll(async () => (await info(host)).ready).toBeGreaterThanOrEqual(3);

  // Guest joins through the invite link in a separate tab.
  const guest = await context.newPage();
  await guest.goto(roomUrl);
  await expectTransport(guest);
  await expect(guest.getByTestId("media-label")).toContainText("clip.webm");
  await expect(host.getByTestId("participant-guest")).toContainText("Ready");
  await expect(guest.getByTestId("participant-host")).toBeVisible();

  // Play
  await video(host).evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(async () => (await info(guest)).paused).toBe(false);
  await host.waitForTimeout(3000);
  const playGap = await gap(host, guest);
  console.log(`play gap: ${playGap.toFixed(3)}s`);
  expect(Math.abs(playGap)).toBeLessThan(0.35);

  // Pause
  await video(host).evaluate((v: HTMLVideoElement) => v.pause());
  await expect.poll(async () => (await info(guest)).paused).toBe(true);
  await host.waitForTimeout(600);
  const pauseGap = await gap(host, guest);
  console.log(`pause gap: ${pauseGap.toFixed(3)}s`);
  expect(Math.abs(pauseGap)).toBeLessThan(0.25);
  await expect(guest.getByTestId("sync-state")).toHaveText("Paused");

  // Seek while paused
  await video(host).evaluate((v: HTMLVideoElement) => (v.currentTime = 40));
  await expect.poll(async () => (await info(guest)).t, { timeout: 3000 }).toBeGreaterThan(39.7);
  expect(Math.abs(await gap(host, guest))).toBeLessThan(0.25);

  // Resume, then seek while playing
  await video(host).evaluate((v: HTMLVideoElement) => v.play());
  await host.waitForTimeout(1000);
  await video(host).evaluate((v: HTMLVideoElement) => (v.currentTime = 10));
  await host.waitForTimeout(2500);
  const seekGap = await gap(host, guest);
  console.log(`seek-while-playing gap: ${seekGap.toFixed(3)}s`);
  expect(Math.abs(seekGap)).toBeLessThan(0.35);

  // Minor drift: guest jumps 0.8s ahead -> playbackRate correction, no seek.
  await video(guest).evaluate((v: HTMLVideoElement) => (v.currentTime += 0.8));
  await expect.poll(async () => (await info(guest)).rate, { timeout: 2000 }).toBeLessThan(1);
  await expect
    .poll(async () => Math.abs(await gap(host, guest)), { timeout: 30_000, intervals: [500] })
    .toBeLessThan(0.35);
  console.log(`after rate correction gap: ${(await gap(host, guest)).toFixed(3)}s`);

  // Major drift: guest 5s behind -> hard seek.
  await video(guest).evaluate((v: HTMLVideoElement) => (v.currentTime -= 5));
  await expect
    .poll(async () => Math.abs(await gap(host, guest)), { timeout: 4000, intervals: [250] })
    .toBeLessThan(0.5);

  // Guest reload: reconnect, get latest state, resume at the right spot.
  await guest.reload();
  await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(false);
  await guest.waitForTimeout(2500);
  const reloadGap = await gap(host, guest);
  console.log(`guest reload gap: ${reloadGap.toFixed(3)}s`);
  expect(Math.abs(reloadGap)).toBeLessThan(0.5);

  // Host reload: host restores its own state; guest keeps following.
  const before = (await info(guest)).t;
  await host.reload();
  await expect(host.getByTestId("media-label")).toContainText("clip.webm");
  await expect.poll(async () => (await info(host)).paused, { timeout: 10_000 }).toBe(false);
  await host.waitForTimeout(2500);
  const hostReloadGap = await gap(host, guest);
  console.log(`host reload gap: ${hostReloadGap.toFixed(3)}s`);
  expect(Math.abs(hostReloadGap)).toBeLessThan(0.5);
  expect((await info(host)).t).toBeGreaterThan(before);
});

test("unsupported sources show a clear compatibility error", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("create-room").click();
  await page.waitForURL(/\/room\//);
  // An image: the probe can't vouch for it, so the HTML5 player tries and fails to decode it.
  await page.getByTestId("source-url").fill(new URL("/favicon.ico", page.url()).toString());
  await page.getByTestId("load-source").click();
  await expect(page.getByTestId("media-error")).toHaveText(/This source is not browser compatible\./);
});

test("guest blocked by autoplay policy gets a join button", async ({ context }) => {
  const host = await context.newPage();
  await host.goto("/");
  await host.getByTestId("create-room").click();
  await host.waitForURL(/\/room\//);
  await host.getByTestId("source-url").fill(new URL(CLIP, host.url()).toString());
  await host.getByTestId("load-source").click();
  await expect.poll(async () => (await info(host)).ready).toBeGreaterThanOrEqual(3);
  await video(host).evaluate((v: HTMLVideoElement) => v.play());

  const guest = await context.newPage();
  // Emulate a browser that blocks play() until the user clicks the page.
  await guest.addInitScript(() => {
    let activated = false;
    window.addEventListener("pointerdown", () => (activated = true), true);
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!activated) return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      return realPlay.call(this);
    };
  });
  await guest.goto(new URL(host.url()).pathname);
  const join = guest.getByTestId("join-playback");
  await expect(join).toBeVisible({ timeout: 10_000 });
  await join.click();
  await expect.poll(async () => (await info(guest)).paused).toBe(false);
  await guest.waitForTimeout(2500);
  expect(Math.abs(await gap(host, guest))).toBeLessThan(0.5);
});

/** Host creates a room with the test clip loaded; returns the room path. */
async function hostRoom(host: Page) {
  await host.goto("/");
  await host.getByTestId("create-room").click();
  await host.waitForURL(/\/room\//);
  await expectTransport(host);
  await host.getByTestId("source-url").fill(new URL(CLIP, host.url()).toString());
  await host.getByTestId("load-source").click();
  await expect.poll(async () => (await info(host)).ready).toBeGreaterThanOrEqual(3);
  return new URL(host.url()).pathname;
}

test("presence shows joins and leaves", async ({ browser, context }) => {
  const host = await context.newPage();
  const roomUrl = await hostRoom(host);
  // Over Supabase the guest gets its own browser context, like a second device.
  // The local fallback only reaches tabs in the same context.
  const guest = await (process.env.E2E_SUPABASE ? await newContext(browser) : context).newPage();
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready");
  await expect(guest.getByTestId("participant-host")).toBeVisible();
  await guest.close();
  await expect(host.getByTestId("participant-guest")).toHaveCount(0, { timeout: 15_000 });
});

test("guest recovers after a network drop", async ({ browser }) => {
  test.skip(!process.env.E2E_SUPABASE, "the local fallback has no network to drop");
  const host = await (await newContext(browser)).newPage();
  const roomUrl = await hostRoom(host);
  const guestCtx = await newContext(browser);
  const guest = await guestCtx.newPage();
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready");
  await video(host).evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(async () => (await info(guest)).paused).toBe(false);

  await guestCtx.setOffline(true);
  await expect(guest.getByTestId("connection")).not.toHaveAttribute("data-status", "connected", { timeout: 15_000 });
  // While the guest is offline the host pauses and seeks; the guest must catch up afterwards.
  await video(host).evaluate((v: HTMLVideoElement) => {
    v.pause();
    v.currentTime = 50;
  });
  await host.waitForTimeout(4000);
  await guestCtx.setOffline(false);
  await expect.poll(async () => (await info(guest)).paused, { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => Math.abs(await gap(host, guest)), { timeout: 5000 }).toBeLessThan(0.25);
  await expect(guest.getByTestId("connection")).toHaveAttribute("data-status", "connected");
});

test("pause for everyone while a guest buffers", async ({ context }) => {
  const host = await context.newPage();
  const roomUrl = await hostRoom(host);
  await host.getByLabel("Pause when a participant buffers").check();
  const guest = await context.newPage();
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready");
  await video(host).evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(async () => (await info(guest)).paused).toBe(false);

  // Simulate the guest running out of data.
  await video(guest).evaluate((v: HTMLVideoElement) => {
    Object.defineProperty(v, "readyState", { configurable: true, get: () => 2 });
    v.dispatchEvent(new Event("waiting"));
  });
  await expect(host.getByTestId("participant-guest")).toContainText("Buffering");
  await expect.poll(async () => (await info(host)).paused, { timeout: 5000 }).toBe(true);
  await expect(guest.getByTestId("sync-state")).toHaveText("Paused");

  // Guest recovers: host resumes on its own.
  await video(guest).evaluate((v: HTMLVideoElement) => {
    delete (v as unknown as { readyState?: number }).readyState;
    v.dispatchEvent(new Event("canplay"));
  });
  await expect.poll(async () => (await info(host)).paused, { timeout: 5000 }).toBe(false);
  await expect.poll(async () => (await info(guest)).paused, { timeout: 5000 }).toBe(false);
});

// ---------- Paste-and-play: every source type through the same sync engine ----------

/** E2E_LIVE_SOURCES=1 swaps the local fixtures for public media (needs open internet). */
const LIVE_SOURCES = [
  { name: "MP4", url: "https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4", kind: "file" },
  { name: "HLS", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", kind: "hls" },
  { name: "DASH", url: "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd", kind: "dash" },
  {
    name: "generic CDN URL without extension",
    // Extensionless path that redirects to the media file, like a CDN download link.
    url: "https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/Blender_Crowd_Simulation.webm",
    kind: "file",
  },
  { name: "YouTube", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", kind: "youtube" },
  { name: "Vimeo", url: "https://vimeo.com/1084537", kind: "vimeo" },
  { name: "WebM", url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm", kind: "file" },
] as const;

const FIXTURE_SOURCES = [
  { name: "MP4", url: "/__test__/clip.mp4", kind: "file" },
  { name: "HLS", url: "/__test__/hls/index.m3u8", kind: "hls" },
  { name: "DASH", url: "/__test__/dash/manifest.mpd", kind: "dash" },
  { name: "generic CDN URL without extension", url: "/__test__/download", kind: "file" },
  { name: "YouTube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", kind: "youtube" },
  { name: "Vimeo", url: "https://vimeo.com/1084537", kind: "vimeo" },
] as const;

const SOURCES = process.env.E2E_LIVE_SOURCES ? LIVE_SOURCES : FIXTURE_SOURCES;

const absolute = (url: string, page: Page) => new URL(url, page.url()).toString();
/** Iframe providers correct drift by seeking only, with a wider dead band. */
const tolerance = (kind: string) => (kind === "youtube" || kind === "vimeo" ? 0.75 : 0.4);

async function paste(host: Page, url: string) {
  await host.getByTestId("source-url").fill(absolute(url, host));
  await host.getByTestId("load-source").click();
}

async function guestPage(browser: Browser, context: BrowserContext) {
  return (process.env.E2E_SUPABASE ? await newContext(browser) : context).newPage();
}

for (const src of SOURCES) {
  test(`${src.name}: host and guest play, pause, seek, correct drift and recover from reloads`, async ({ browser, context }) => {
    const tol = tolerance(src.kind);
    const host = await context.newPage();
    await host.goto("/");
    await host.getByTestId("create-room").click();
    await host.waitForURL(/\/room\//);
    await expectTransport(host);
    await paste(host, src.url);
    await expect(host.getByTestId("stage")).toHaveAttribute("data-kind", src.kind);
    await expect.poll(async () => (await info(host)).ready, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);

    const guest = await guestPage(browser, context);
    await guest.goto(new URL(host.url()).pathname);
    await expectTransport(guest);
    await expect(guest.getByTestId("stage")).toHaveAttribute("data-kind", src.kind);
    await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 20_000 });

    // Play (for YouTube/Vimeo this drives the provider's own player, like its play button).
    await act(host, "play");
    await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(false);
    await host.waitForTimeout(3000);
    const playGap = await gap(host, guest);
    console.log(`${src.name} play gap: ${playGap.toFixed(3)}s`);
    expect(Math.abs(playGap)).toBeLessThan(tol);

    // Pause
    await act(host, "pause");
    await expect.poll(async () => (await info(guest)).paused, { timeout: 5000 }).toBe(true);
    await expect.poll(async () => Math.abs(await gap(host, guest)), { timeout: 5000 }).toBeLessThan(0.3);
    console.log(`${src.name} pause gap: ${(await gap(host, guest)).toFixed(3)}s`);

    // Seek while paused
    await act(host, { seek: 40 });
    await expect.poll(async () => Math.abs(await gap(host, guest)), { timeout: 8000 }).toBeLessThan(0.3);
    console.log(`${src.name} seek gap: ${(await gap(host, guest)).toFixed(3)}s`);

    // Resume, then drift: the guest jumps 3s ahead and must be pulled back.
    await act(host, "play");
    await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(false);
    await host.waitForTimeout(1500);
    await act(guest, { nudge: 3 });
    await expect
      .poll(async () => Math.abs(await gap(host, guest)), { timeout: 10_000, intervals: [250] })
      .toBeLessThan(tol);
    console.log(`${src.name} after drift correction gap: ${(await gap(host, guest)).toFixed(3)}s`);

    // Guest refresh
    await guest.reload();
    await expect.poll(async () => (await info(guest)).paused, { timeout: 15_000 }).toBe(false);
    await expect
      .poll(async () => Math.abs(await gap(host, guest)), { timeout: 10_000, intervals: [500] })
      .toBeLessThan(tol);
    console.log(`${src.name} guest refresh gap: ${(await gap(host, guest)).toFixed(3)}s`);

    // Host refresh: the host restores its own room state and the guest keeps following.
    await host.reload();
    await expect(host.getByTestId("stage")).toHaveAttribute("data-kind", src.kind);
    await expect.poll(async () => (await info(host)).paused, { timeout: 15_000 }).toBe(false);
    await expect
      .poll(async () => Math.abs(await gap(host, guest)), { timeout: 10_000, intervals: [500] })
      .toBeLessThan(tol);
    console.log(`${src.name} host refresh gap: ${(await gap(host, guest)).toFixed(3)}s`);
  });
}

test("switching source types in the same room", async ({ browser, context }) => {
  const host = await context.newPage();
  await host.goto("/");
  await host.getByTestId("create-room").click();
  await host.waitForURL(/\/room\//);
  await expectTransport(host);
  const guest = await guestPage(browser, context);
  await guest.goto(new URL(host.url()).pathname);
  await expectTransport(guest);

  for (const src of [SOURCES[0], SOURCES[4], SOURCES[1], SOURCES[5], SOURCES[2]]) {
    await paste(host, src.url);
    await expect(host.getByTestId("stage")).toHaveAttribute("data-kind", src.kind);
    await expect(guest.getByTestId("stage")).toHaveAttribute("data-kind", src.kind, { timeout: 10_000 });
    // Exactly one player per page: the previous adapter was torn down.
    const players = VIA_ADAPTER ? '[data-testid="video"], [data-testid="provider-player"]' : '[data-testid="video"]';
    await expect(host.locator(players)).toHaveCount(1, { timeout: 10_000 });
    await expect(guest.locator(players)).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(async () => (await info(host)).ready, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 20_000 });
    await act(host, "play");
    await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(false);
    await host.waitForTimeout(3000);
    console.log(`switch -> ${src.name} gap at 3s: ${(await gap(host, guest)).toFixed(3)}s`);
    // Remote streams with long segments can start a little apart; the guest must converge.
    await expect
      .poll(async () => Math.abs(await gap(host, guest)), { timeout: 15_000, intervals: [500] })
      .toBeLessThan(tolerance(src.kind));
    const g = await gap(host, guest);
    console.log(`switch -> ${src.name} gap: ${g.toFixed(3)}s`);
    expect(Math.abs(g)).toBeLessThan(tolerance(src.kind));
  }
});

test("sources that can't be played directly say so", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("create-room").click();
  await page.waitForURL(/\/room\//);
  const cant = "This source can't be played directly.";

  // A web page, not media. Locally the server probes its own page; deployed, a public one.
  await paste(page, process.env.E2E_BASE_URL ? "https://example.com/" : "/");
  await expect(page.getByTestId("source-error")).toHaveText(cant);
  await expect(page.getByTestId("media-label")).toHaveText("Nothing loaded.");

  for (const url of ["ftp://example.com/movie.mp4", "https://www.youtube.com/playlist?list=PL0123456789"]) {
    await paste(page, url);
    await expect(page.getByTestId("source-error")).toHaveText(cant);
  }

  // Embedding disabled on YouTube, private on Vimeo.
  await paste(page, "https://www.youtube.com/watch?v=unembeddabl");
  await expect(page.getByTestId("media-error")).toHaveText(cant, { timeout: 10_000 });
  await paste(page, "https://vimeo.com/999999999");
  await expect(page.getByTestId("media-error")).toHaveText(cant, { timeout: 10_000 });
});

const SRT = [
  "1\n00:00:00,000 --> 00:00:10,000\nمرحبا بكم في الحفلة\n",
  "2\n00:00:10,000 --> 00:00:20,000\n<i>Second line</i>\n",
].join("\n");
const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:30.000\n<v Host>From a link</v>\n";

test("subtitles: upload, link, RTL, delay and hide are shared with guests", async ({ browser, context }) => {
  const host = await context.newPage();
  const roomUrl = await hostRoom(host);
  const guest = await guestPage(browser, context);
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 20_000 });

  // Upload an Arabic SRT; both sides show it, right-to-left.
  await host.getByTestId("subtitle-file").setInputFiles({ name: "arabic.srt", mimeType: "application/x-subrip", buffer: Buffer.from(SRT) });
  await expect(host.getByTestId("subtitle-name")).toHaveText("arabic.srt");
  await act(host, { seek: 5 });
  for (const page of [host, guest]) {
    const line = page.getByTestId("subtitle-text").locator("p");
    await expect(line).toHaveText("مرحبا بكم في الحفلة", { timeout: 10_000 });
    expect(await line.evaluate((p) => getComputedStyle(p).direction)).toBe("rtl");
  }

  // Seek past the first cue, then delay subtitles by 0.5 s: the first cue shows again for everyone.
  await act(host, { seek: 10.2 });
  await expect(guest.getByTestId("subtitle-text")).toHaveText("Second line", { timeout: 10_000 });
  await host.getByTestId("subtitle-later").click();
  await expect(guest.getByTestId("subtitle-offset")).toHaveText("+0.5s");
  await expect(guest.getByTestId("subtitle-text")).toHaveText("مرحبا بكم في الحفلة", { timeout: 10_000 });

  // Hiding is local to each viewer.
  await guest.getByTestId("subtitle-toggle").click();
  await expect(guest.getByTestId("subtitle-text")).toHaveCount(0);
  await expect(host.getByTestId("subtitle-text")).toHaveCount(1);
  await guest.getByTestId("subtitle-toggle").click();

  // A WebVTT link (fetched by the host's browser) replaces the file.
  for (const ctx of new Set([host.context(), guest.context()])) {
    await ctx.route("https://subs.example.test/**", (route) =>
      route.fulfill({ body: VTT, headers: { "Content-Type": "text/vtt", "Access-Control-Allow-Origin": "*" } }),
    );
  }
  await host.getByTestId("subtitle-url").fill("https://subs.example.test/movie.vtt");
  await host.getByTestId("subtitle-load").click();
  await expect(guest.getByTestId("subtitle-name")).toHaveText("movie.vtt");
  await expect(guest.getByTestId("subtitle-offset")).toHaveText("0.0s");
  await expect(guest.getByTestId("subtitle-text")).toHaveText("From a link", { timeout: 10_000 });

  // A late joiner gets the subtitles too.
  const late = await guestPage(browser, context);
  await late.goto(roomUrl);
  await expect(late.getByTestId("subtitle-text")).toHaveText("From a link", { timeout: 15_000 });

  // Not a subtitle file.
  await host.getByTestId("subtitle-file").setInputFiles({ name: "notes.srt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(host.getByTestId("subtitle-error")).toContainText("No subtitles found");
});
