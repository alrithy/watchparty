import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve as resolvePath } from "node:path";
import { expect, test as base, type Browser, type BrowserContext, type Page } from "@playwright/test";

const CLIP = "/__test__/clip.webm";

const TYPES: Record<string, string> = {
  webm: "video/webm",
  mp4: "video/mp4",
  m3u8: "application/vnd.apple.mpegurl",
  mpd: "application/dash+xml",
  mkv: "video/x-matroska",
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

/**
 * Reads the page's <video> when there is one; otherwise (Movi draws on a canvas, or the player is
 * mid-way through switching decoders) the active adapter. Decided in one evaluate, so an element
 * that's torn down between checks can't leave the test waiting on it.
 */
const info = (page: Page): Promise<VideoInfo> =>
  page.evaluate((via) => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="video"]');
    if (!via && v) return { t: v.currentTime, paused: v.paused, rate: v.playbackRate, ready: v.readyState };
    const p = (window as unknown as { __watchparty?: { player(): Adapter | null } }).__watchparty?.player();
    if (!p) return { t: 0, paused: true, rate: 1, ready: 0 };
    return { t: p.currentTime(), paused: !p.playing(), rate: p.rate(), ready: p.ready() ? (p.canContinue() ? 4 : 1) : 0 };
  }, VIA_ADAPTER);

/** Play/pause/seek like a person using the player's own controls. */
async function act(page: Page, action: "play" | "pause" | { seek: number } | { nudge: number }) {
  await page.evaluate(
    ([a, via]) => {
      const v = document.querySelector<HTMLVideoElement>('[data-testid="video"]');
      if (!via && v) {
        if (a === "play") void v.play();
        else if (a === "pause") v.pause();
        else if ("seek" in a) v.currentTime = a.seek;
        else v.currentTime += a.nudge;
        return;
      }
      const p = (window as unknown as { __watchparty?: { player(): Adapter | null } }).__watchparty?.player();
      if (!p) throw new Error("no player");
      if (a === "play") void p.play().catch(() => {});
      else if (a === "pause") p.pause();
      else if ("seek" in a) p.seek(a.seek);
      else p.seek(p.currentTime() + a.nudge);
    },
    [action, VIA_ADAPTER] as const,
  );
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
  // A seek into unbuffered media has to download first, so give the guest time to land.
  await expect
    .poll(async () => Math.abs(await gap(host, guest)), { timeout: 15_000, intervals: [500] })
    .toBeLessThan(0.35);
  const seekGap = await gap(host, guest);
  console.log(`seek-while-playing gap: ${seekGap.toFixed(3)}s`);
  expect(Math.abs(seekGap)).toBeLessThan(0.35);

  // Minor drift: guest jumps 0.45s ahead -> playbackRate correction, no seek.
  // (Past ~0.5s with the target buffered, the guest seeks instead; see "Major drift" below.)
  await video(guest).evaluate((v: HTMLVideoElement) => (v.currentTime += 0.45));
  // Over a real network the measured drift varies, so only the local run can insist on the rate path.
  if (!process.env.E2E_BASE_URL) await expect.poll(async () => (await info(guest)).rate, { timeout: 2000 }).toBeLessThan(1);
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
  // CORS is allowed so the Movi fallback can read it too: both decoders must refuse it.
  await page.route("https://files.example.test/clip", (route) =>
    route.fulfill({ body: "GIF89a", headers: { "Content-Type": "application/octet-stream", "Access-Control-Allow-Origin": "*" } }),
  );
  await page.getByTestId("source-url").fill("https://files.example.test/clip");
  await page.getByTestId("load-source").click();
  // Both decoders get to try first (the fallback one loads on demand).
  await expect(page.getByTestId("media-error")).toHaveText(/This source is not browser compatible\./, { timeout: 20_000 });
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
async function hostRoom(host: Page, clip = CLIP) {
  await host.goto("/");
  await host.getByTestId("create-room").click();
  await host.waitForURL(/\/room\//);
  await expectTransport(host);
  await host.getByTestId("source-url").fill(new URL(clip, host.url()).toString());
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
/** Played by Movi: MKV straight away, HEVC after <video> fails on it. */
const MKV_SOURCE = { name: "MKV H.264 + AC-3", url: "/__test__/clip.mkv", kind: "file", engine: "movi" } as const;
const MOVI_SOURCES = [
  MKV_SOURCE,
  { name: "HEVC Main10 + E-AC-3 without extension", url: "/__test__/download-hevc", kind: "file", engine: "movi" },
] as const;
/**
 * Deployed runs serve the fixtures from the test machine, which the server-side probe of an
 * extensionless link can't reach; an .mp4 the browser can't decode takes the same fallback.
 */
const LIVE_MOVI_SOURCES = [
  MKV_SOURCE,
  { name: "HEVC Main10 + E-AC-3 in MP4", url: "/__test__/hevc.mp4", kind: "file", engine: "movi" },
] as const;

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
  // Served from the test machine (see prepareContext) on deployed runs too.
  ...LIVE_MOVI_SOURCES,
] as const;

const FIXTURE_SOURCES = [
  { name: "MP4", url: "/__test__/clip.mp4", kind: "file" },
  { name: "HLS", url: "/__test__/hls/index.m3u8", kind: "hls" },
  { name: "DASH", url: "/__test__/dash/manifest.mpd", kind: "dash" },
  { name: "generic CDN URL without extension", url: "/__test__/download", kind: "file" },
  { name: "YouTube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", kind: "youtube" },
  { name: "Vimeo", url: "https://vimeo.com/1084537", kind: "vimeo" },
  ...MOVI_SOURCES,
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
    if ("engine" in src) {
      for (const page of [host, guest]) await expect(page.locator('[data-provider="movi"]')).toHaveCount(1, { timeout: 20_000 });
    }
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

  // MKV (Movi) -> YouTube -> MP4 -> MKV, then the stream types. Live runs come from datacenter IPs,
  // where real YouTube/Vimeo refuse to play; they switch across the direct source types instead.
  const order = process.env.E2E_LIVE_SOURCES ? [7, 0, 7, 1, 2, 6, 3] : [6, 4, 0, 6, 1, 5, 2];
  for (const src of order.map((i) => SOURCES[i])) {
    await paste(host, src.url);
    await expect(host.getByTestId("stage")).toHaveAttribute("data-kind", src.kind);
    await expect(guest.getByTestId("stage")).toHaveAttribute("data-kind", src.kind, { timeout: 10_000 });
    // Exactly one player per page: the previous adapter was torn down.
    const players = VIA_ADAPTER
      ? '[data-testid="video"], [data-testid="provider-player"]'
      : '[data-testid="video"], [data-provider="movi"]';
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

function choice(id: string, release: string, percent: number, confidence: "high" | "low") {
  return {
    provider: "opensubtitles",
    id,
    release,
    language: "ar",
    hearingImpaired: false,
    machineTranslated: false,
    downloads: 10,
    rating: null,
    trusted: false,
    fps: null,
    feature: { imdbId: null, title: "Big Buck Bunny", year: 2008, season: null, episode: null },
    score: percent,
    percent,
    confidence,
    reasons: confidence === "high" ? ["Title", "Year 2008", "Arabic"] : ["Title", "Arabic"],
  };
}

test("subtitles: Find Arabic subtitles asks when unsure, applies a confident match, and guests get it", async ({ browser, context }) => {
  const host = await context.newPage();
  const roomUrl = await hostRoom(host);
  const guest = await guestPage(browser, context);
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 20_000 });

  // The providers are behind our server; stand in for its two routes.
  const searches: { title?: string }[] = [];
  await host.route("**/api/subtitles/search", async (route) => {
    const body = route.request().postDataJSON() as { title?: string };
    searches.push(body);
    if (!body.title) {
      await route.fulfill({
        json: {
          needTitle: false,
          wanted: { title: "bbb", year: null, season: null, episode: null },
          results: [choice("1", "Big.Buck.Bunny.2008.720p", 22, "low"), choice("2", "Big.Buck.Bunny.Remake", 20, "low")],
          autoSelect: false,
          errors: [{ provider: "subdl", message: "SubDL didn't respond." }],
        },
      });
    } else {
      await route.fulfill({
        json: {
          needTitle: false,
          wanted: { title: "Big Buck Bunny", year: 2008, season: null, episode: null },
          results: [choice("3", "Big.Buck.Bunny.2008.1080p", 67, "high"), choice("1", "Big.Buck.Bunny.2008.720p", 22, "low")],
          autoSelect: true,
          errors: [],
        },
      });
    }
  });
  const downloads: string[] = [];
  await host.route("**/api/subtitles/download", async (route) => {
    const { id } = route.request().postDataJSON() as { id: string };
    downloads.push(id);
    const text = id === "3" ? "1\n00:00:00,000 --> 00:00:30,000\nترجمة تلقائية\n" : "1\n00:00:00,000 --> 00:00:30,000\nاختيار يدوي\n";
    await route.fulfill({ body: text, headers: { "Content-Type": "application/octet-stream" } });
  });
  await act(host, { seek: 5 });

  // Low confidence: nothing is applied; the host sees the top matches and why.
  await host.getByTestId("subtitle-find").click();
  await expect(host.getByTestId("subtitle-pick")).toBeVisible();
  await expect(host.getByTestId("subtitle-choice")).toHaveCount(2);
  await expect(host.getByTestId("subtitle-provider-error")).toHaveText("SubDL didn't respond.");
  expect(downloads).toEqual([]);
  await expect(host.getByTestId("subtitle-name")).toHaveText("None");

  // Picking one shares it with the guest.
  await host.getByTestId("subtitle-choice").first().getByRole("button", { name: "Use" }).click();
  await expect(guest.getByTestId("subtitle-text")).toHaveText("اختيار يدوي", { timeout: 10_000 });
  await expect(guest.getByTestId("subtitle-name")).toHaveText("Big.Buck.Bunny.2008.720p");

  // Searching a typed title finds a confident match, which is applied without asking.
  await host.getByTestId("subtitle-title").fill("Big Buck Bunny 2008");
  await host.getByTestId("subtitle-title").press("Enter");
  await expect(host.getByTestId("subtitle-match")).toContainText("67%");
  await expect(guest.getByTestId("subtitle-text")).toHaveText("ترجمة تلقائية", { timeout: 10_000 });
  expect(searches.at(-1)?.title).toBe("Big Buck Bunny 2008");
  expect(downloads).toEqual(["1", "3"]);

  // Manual subtitles and the shared delay still work alongside it.
  await host.getByTestId("subtitle-later").click();
  await expect(guest.getByTestId("subtitle-offset")).toHaveText("+0.5s");
});

// ---------- Movi: MKV/HEVC fallback ----------

test("MKV: a 45-minute seek, pause and play after it, and the guest follows", async ({ browser, context }) => {
  const host = await context.newPage();
  const roomUrl = await hostRoom(host, "/__test__/long.mkv");
  await expect(host.locator('[data-provider="movi"]')).toHaveCount(1);
  expect(await host.evaluate(() => (window as unknown as { __watchparty: { player(): { duration(): number } } }).__watchparty.player().duration())).toBeGreaterThan(3500);
  const guest = await guestPage(browser, context);
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 20_000 });

  // The host drives Movi with our own small control bar (a canvas has no native controls).
  await host.getByTestId("movi-play").click();
  await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(false);
  await act(host, { seek: 45 * 60 });
  await expect.poll(async () => (await info(guest)).t, { timeout: 15_000 }).toBeGreaterThan(45 * 60);
  await expect.poll(async () => Math.abs(await gap(host, guest)), { timeout: 15_000, intervals: [500] }).toBeLessThan(0.4);
  console.log(`MKV 45-min seek gap: ${(await gap(host, guest)).toFixed(3)}s`);

  await act(host, "pause");
  await expect.poll(async () => (await info(guest)).paused, { timeout: 5000 }).toBe(true);
  await expect.poll(async () => Math.abs(await gap(host, guest)), { timeout: 5000 }).toBeLessThan(0.3);
  console.log(`MKV pause after seek gap: ${(await gap(host, guest)).toFixed(3)}s`);
  await act(host, "play");
  await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(false);
  await host.waitForTimeout(3000);
  const g = await gap(host, guest);
  console.log(`MKV play after seek gap: ${g.toFixed(3)}s`);
  expect(Math.abs(g)).toBeLessThan(0.4);
  expect((await info(host)).t).toBeGreaterThan(45 * 60 + 2);
});

test("MKV: subtitles overlay and delay work on Movi", async ({ browser, context }) => {
  const host = await context.newPage();
  const roomUrl = await hostRoom(host, "/__test__/clip.mkv");
  await expect(host.locator('[data-provider="movi"]')).toHaveCount(1);
  const guest = await guestPage(browser, context);
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 20_000 });

  await host.getByTestId("subtitle-file").setInputFiles({ name: "arabic.srt", mimeType: "application/x-subrip", buffer: Buffer.from(SRT) });
  await act(host, { seek: 5 });
  for (const page of [host, guest]) {
    await expect(page.getByTestId("subtitle-text").locator("p")).toHaveText("مرحبا بكم في الحفلة", { timeout: 10_000 });
  }
  await act(host, { seek: 10.2 });
  await expect(guest.getByTestId("subtitle-text")).toHaveText("Second line", { timeout: 10_000 });
  await host.getByTestId("subtitle-later").click();
  await expect(guest.getByTestId("subtitle-offset")).toHaveText("+0.5s");
  await expect(guest.getByTestId("subtitle-text")).toHaveText("مرحبا بكم في الحفلة", { timeout: 10_000 });
});

/**
 * iPhone Safari has no element fullscreen: only `video.webkitEnterFullscreen()`, Apple's own
 * player, which drops our subtitle overlay. This makes Chromium look like that: the calls are
 * counted and fire the `webkitbeginfullscreen` / `webkitendfullscreen` events iPhone fires.
 */
async function iPhoneContext(browser: Browser) {
  const ctx = await browser.newContext({
    storageState: test.info().project.use.storageState,
    viewport: { width: 844, height: 390 },
    hasTouch: true,
  });
  await prepareContext(ctx);
  await ctx.addInitScript(() => {
    Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false });
    Object.defineProperty(Document.prototype, "webkitFullscreenEnabled", { get: () => false });
    // iOS keeps media volume at 1; the side buttons own it.
    const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume")!;
    Object.defineProperty(HTMLMediaElement.prototype, "volume", { get: volume.get, set() {} });
    const w = window as unknown as { nativeVideoFullscreen: number; nativeVideoExit: number };
    w.nativeVideoFullscreen = 0;
    w.nativeVideoExit = 0;
    Object.defineProperty(HTMLVideoElement.prototype, "webkitEnterFullscreen", {
      value(this: HTMLVideoElement) {
        w.nativeVideoFullscreen++;
        this.dispatchEvent(new Event("webkitbeginfullscreen"));
      },
    });
    Object.defineProperty(HTMLVideoElement.prototype, "webkitExitFullscreen", {
      value(this: HTMLVideoElement) {
        w.nativeVideoExit++;
        this.dispatchEvent(new Event("webkitendfullscreen"));
      },
    });
  });
  return ctx;
}

const counter = (page: Page, name: "nativeVideoFullscreen" | "nativeVideoExit") =>
  page.evaluate((n) => (window as unknown as Record<string, number>)[n], name);
const box = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!;
/** Taps the page's Fullscreen button in place (Playwright's own click would scroll the page first). */
const tapFullscreen = (page: Page) => page.getByTestId("fullscreen").evaluate((b: HTMLButtonElement) => b.click());

for (const clip of [CLIP, "/__test__/clip.mkv"]) {
  test(`iPhone fullscreen keeps Arabic subtitles on the picture (${clip.endsWith(".mkv") ? "Movi" : "video"})`, async ({ browser }) => {
    const ctx = await iPhoneContext(browser);
    const host = await ctx.newPage();
    const roomUrl = await hostRoom(host, clip);
    const guest = await (process.env.E2E_SUPABASE ? await iPhoneContext(browser) : ctx).newPage();
    await guest.goto(roomUrl);
    await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 20_000 });
    await host.getByTestId("subtitle-file").setInputFiles({ name: "arabic.srt", mimeType: "application/x-subrip", buffer: Buffer.from(SRT) });
    await act(host, { seek: 2 });
    await act(host, "play");
    await host.evaluate(() => window.scrollTo(0, 150));
    const scrolled = await host.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);

    await tapFullscreen(host);
    const screen = host.getByTestId("screen");
    await expect(screen).toHaveAttribute("data-immersive", "true");
    await expect(screen).toHaveAttribute("role", "dialog");
    await expect(host.getByTestId("exit-fullscreen")).toBeFocused();
    expect(await counter(host, "nativeVideoFullscreen")).toBe(0);
    expect(await host.evaluate(() => document.fullscreenElement)).toBeNull();
    // The <video>'s own controls (with Apple's fullscreen button) are off; ours are on, Movi's bar gives way.
    if (clip === CLIP) expect(await video(host).evaluate((v: HTMLVideoElement) => v.controls)).toBe(false);
    else await expect(host.getByTestId("movi-controls")).toBeHidden();
    const controls = host.getByTestId("immersive-controls");
    await expect(controls).toBeVisible();
    await expect(controls.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(controls.getByRole("slider", { name: "Seek" })).toBeVisible();
    await expect(controls.getByRole("button", { name: "Mute" })).toBeVisible();
    // No inert volume slider on iPhone: Mute here, level on the side buttons.
    await expect(controls.getByRole("slider", { name: "Volume" })).toHaveCount(0);

    // The player covers the viewport and the 16:9 picture fits inside it, with the subtitles on it.
    const check = async (w: number, h: number) => {
      expect(await box(host, "screen")).toEqual({ x: 0, y: 0, width: w, height: h });
      const frame = await box(host, "frame");
      expect(frame.width).toBeCloseTo(Math.min(w, (h * 16) / 9), 0);
      expect(frame.height).toBeLessThanOrEqual(h + 0.5);
      const line = host.getByTestId("subtitle-text").locator("p");
      await expect(line).toHaveText("مرحبا بكم في الحفلة", { timeout: 10_000 });
      await expect(line).toBeInViewport({ ratio: 1 });
      expect(await line.evaluate((p) => getComputedStyle(p).direction)).toBe("rtl");
      const text = await box(host, "subtitle-text");
      expect(text.y + text.height).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
      expect(text.y).toBeGreaterThanOrEqual(frame.y);
    };
    await check(844, 390);
    // Turning the phone upright keeps everything on screen.
    await host.setViewportSize({ width: 390, height: 844 });
    await check(390, 844);
    await host.setViewportSize({ width: 844, height: 390 });

    // The page underneath doesn't scroll, and playback keeps going inline.
    expect(await host.evaluate(() => getComputedStyle(document.body).position)).toBe("fixed");
    await host.mouse.wheel(0, 400);
    const t0 = (await info(host)).t;
    await expect.poll(async () => (await info(host)).t).toBeGreaterThan(t0 + 0.5);
    if (clip === CLIP) expect(await video(host).evaluate((v: HTMLVideoElement) => v.playsInline)).toBe(true);

    // The controls fade while playing and come back on a tap.
    await expect(controls).toHaveCSS("opacity", "0", { timeout: 6000 });
    await host.getByTestId("frame").tap();
    await expect(controls).toHaveCSS("opacity", "1");

    // Host controls drive the room: pause, seek past the first cue, play.
    await controls.getByRole("button", { name: "Pause" }).tap();
    await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(true);
    const seek = controls.getByRole("slider", { name: "Seek" });
    await seek.fill("12");
    await seek.blur();
    await expect.poll(async () => (await info(guest)).t, { timeout: 10_000 }).toBeGreaterThan(11.5);
    await expect(host.getByTestId("subtitle-text")).toHaveText("Second line", { timeout: 10_000 });
    await controls.getByRole("button", { name: "Play" }).tap();
    await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(false);
    // Mute is local only.
    await controls.getByRole("button", { name: "Mute" }).tap();
    await expect(controls.getByRole("button", { name: "Unmute" })).toBeVisible();
    await expect(host.getByTestId("fullscreen")).toHaveText("Exit fullscreen");

    // Escape and the exit button both leave it, restoring the page, its scroll position and the controls.
    await host.keyboard.press("Escape");
    await expect(screen).not.toHaveAttribute("data-immersive");
    await expect(host.getByTestId("immersive-controls")).toHaveCount(0);
    expect(await host.evaluate(() => getComputedStyle(document.body).position)).toBe("static");
    expect(await host.evaluate(() => window.scrollY)).toBe(scrolled);
    if (clip === CLIP) expect(await video(host).evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
    else await expect(host.getByTestId("movi-controls")).toBeVisible();
    await tapFullscreen(host);
    await host.getByTestId("exit-fullscreen").click();
    await expect(screen).not.toHaveAttribute("data-immersive");
    await expect(host.getByTestId("exit-fullscreen")).toHaveCount(0);
    await expect(host.getByTestId("fullscreen")).toHaveText("Fullscreen");
    expect(await counter(host, "nativeVideoFullscreen")).toBe(0);

    // A guest's fullscreen has volume and exit, but no transport: the host controls playback.
    await tapFullscreen(guest);
    const guestControls = guest.getByTestId("immersive-controls");
    await expect(guestControls.getByRole("button", { name: "Mute" })).toBeVisible();
    await expect(guestControls.getByRole("slider", { name: "Seek" })).toHaveCount(0);
    await expect(guestControls.getByRole("button", { name: /Play|Pause/ })).toHaveCount(0);
    await expect(guest.getByTestId("subtitle-text")).toHaveCount(1, { timeout: 10_000 });
    await guest.getByTestId("exit-fullscreen").click();
    await ctx.close();
  });
}

// A 2.40:1 film used to sit in a 16:9 box: black bars on all four sides at once.
for (const clip of ["/__test__/wide.mp4", "/__test__/wide.mkv"]) {
  test(`iPhone fullscreen sizes to a 2.40:1 picture with no extra bars, Fit and Fill (${clip.endsWith(".mkv") ? "Movi" : "video"})`, async ({ browser }) => {
    const ctx = await iPhoneContext(browser);
    const host = await ctx.newPage();
    await hostRoom(host, clip);
    if (clip.endsWith(".mkv")) await expect(host.locator('[data-provider="movi"]')).toHaveCount(1);
    await host.getByTestId("subtitle-file").setInputFiles({ name: "arabic.srt", mimeType: "application/x-subrip", buffer: Buffer.from(SRT) });
    await act(host, { seek: 2 });
    await tapFullscreen(host);
    await expect(host.getByTestId("screen")).toHaveAttribute("data-immersive", "true");

    const ratio = 480 / 200;
    // The picture box has the picture's own shape and is as large as fits: bars on one axis at most.
    const check = async (w: number, h: number) => {
      await expect.poll(async () => {
        const f = await box(host, "frame");
        return Math.round(f.width / f.height * 100) / 100;
      }).toBeCloseTo(ratio, 1);
      const f = await box(host, "frame");
      expect(f.width).toBeCloseTo(Math.min(w, h * ratio), 0);
      expect(f.height).toBeCloseTo(Math.min(h, w / ratio), 0);
      // Centred, and the player inside fills it (no 16:9 box inside the picture box).
      expect(f.x).toBeCloseTo((w - f.width) / 2, 0);
      expect(f.y).toBeCloseTo((h - f.height) / 2, 0);
      const player = (await host.getByTestId("stage").locator(":scope > *").first().boundingBox())!;
      expect(player).toEqual(f);
      // Subtitles sit on the picture, not on a black strip.
      const line = host.getByTestId("subtitle-text").locator("p");
      await expect(line).toHaveText("مرحبا بكم في الحفلة", { timeout: 10_000 });
      const text = await box(host, "subtitle-text");
      expect(text.y).toBeGreaterThanOrEqual(f.y);
      expect(text.y + text.height).toBeLessThanOrEqual(f.y + f.height + 0.5);
    };
    await check(844, 390);
    await host.setViewportSize({ width: 390, height: 844 });
    await check(390, 844);
    await host.setViewportSize({ width: 844, height: 390 });
    await check(844, 390);

    // Fill crops to cover the screen; Fit (the default) brings the whole picture back.
    const controls = host.getByTestId("immersive-controls");
    await host.getByTestId("frame").tap();
    await controls.getByRole("button", { name: "Fill screen" }).tap();
    await expect(host.getByTestId("screen")).toHaveAttribute("data-fit", "cover");
    await expect.poll(() => box(host, "frame")).toEqual({ x: 0, y: 0, width: 844, height: 390 });
    if (clip.endsWith(".mp4")) expect(await video(host).evaluate((v) => getComputedStyle(v).objectFit)).toBe("cover");
    await expect(host.getByTestId("subtitle-text").locator("p")).toBeInViewport({ ratio: 1 });
    await controls.getByRole("button", { name: "Fit whole picture" }).tap();
    await check(844, 390);
    if (clip.endsWith(".mp4")) expect(await video(host).evaluate((v) => getComputedStyle(v).objectFit)).toBe("contain");

    // Leaving fullscreen puts the normal page player back as it was.
    await host.getByTestId("exit-fullscreen").click();
    await expect(host.getByTestId("screen")).not.toHaveAttribute("data-immersive");
    const page = await box(host, "frame");
    expect(page.width / page.height).toBeCloseTo(16 / 9, 1);
    await ctx.close();
  });
}

test("iPhone: the video's own fullscreen button lands in the app's fullscreen instead", async ({ browser }) => {
  const ctx = await iPhoneContext(browser);
  const host = await ctx.newPage();
  await hostRoom(host);
  await host.getByTestId("subtitle-file").setInputFiles({ name: "arabic.srt", mimeType: "application/x-subrip", buffer: Buffer.from(SRT) });
  await act(host, { seek: 2 });

  // What tapping the fullscreen button in the native controls does on iPhone.
  await video(host).evaluate((v: HTMLVideoElement & { webkitEnterFullscreen(): void }) => v.webkitEnterFullscreen());
  await expect(host.getByTestId("screen")).toHaveAttribute("data-immersive", "true");
  expect(await counter(host, "nativeVideoExit")).toBe(1);
  await expect(host.getByTestId("subtitle-text").locator("p")).toHaveText("مرحبا بكم في الحفلة", { timeout: 10_000 });
  await ctx.close();
});

test("iPhone, nativesubs experiment: Apple's player gets the subtitles as a native track, with the delay", async ({ browser }) => {
  const ctx = await iPhoneContext(browser);
  const host = await ctx.newPage();
  const roomUrl = await hostRoom(host);
  await host.goto(`${roomUrl}?nativesubs=1`);
  await expect.poll(async () => (await info(host)).ready, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  const track = () =>
    video(host).evaluate((v: HTMLVideoElement) => {
      const t = v.textTracks[0];
      if (!t) return null;
      const mode = t.mode;
      if (mode === "disabled") return { mode, cues: [] };
      return { mode, cues: Array.from(t.cues ?? []).map((c) => [c.startTime, c.endTime, (c as VTTCue).text]) };
    });
  await host.getByTestId("subtitle-file").setInputFiles({ name: "arabic.srt", mimeType: "application/x-subrip", buffer: Buffer.from(SRT) });
  await host.getByTestId("subtitle-later").click();
  await act(host, { seek: 2 });
  await expect(host.getByTestId("subtitle-text")).toHaveCount(1, { timeout: 10_000 });
  // Installed before Apple's player opens (Safari may not draw a track added later), but hidden inline.
  await expect.poll(async () => (await track())?.mode).toBe("hidden");
  expect((await track())?.cues).toHaveLength(2);

  await tapFullscreen(host);
  expect(await counter(host, "nativeVideoFullscreen")).toBe(1);
  await expect(host.getByTestId("screen")).not.toHaveAttribute("data-immersive");
  // Only one set of subtitles: the overlay steps aside for the native track.
  await expect(host.getByTestId("subtitle-text")).toHaveCount(0);
  await expect.poll(track).toEqual({
    mode: "showing",
    cues: [
      [0.5, 10.5, "مرحبا بكم في الحفلة"],
      [10.5, 20.5, "Second line"],
    ],
  });
  // A new delay is applied to the native track too.
  await host.getByTestId("subtitle-later").evaluate((b: HTMLButtonElement) => b.click());
  await expect.poll(async () => (await track())?.cues[0]).toEqual([1, 11, "مرحبا بكم في الحفلة"]);

  // Leaving Apple's player hides the track again and brings the overlay back.
  await video(host).evaluate((v: HTMLVideoElement & { webkitExitFullscreen(): void }) => v.webkitExitFullscreen());
  await expect.poll(async () => (await track())?.mode).toBe("hidden");
  await expect(host.getByTestId("subtitle-text")).toHaveCount(1, { timeout: 10_000 });
  await ctx.close();
});

test("iPhone, 30-minute seek on Movi: subtitles, pause/resume and delay hold in fullscreen, and the guest follows", async ({ browser }) => {
  const ctx = await iPhoneContext(browser);
  const host = await ctx.newPage();
  const roomUrl = await hostRoom(host, "/__test__/long.mkv");
  const guest = await (process.env.E2E_SUPABASE ? await iPhoneContext(browser) : ctx).newPage();
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 20_000 });
  const srt = "1\n00:30:00,000 --> 00:30:10,000\nبعد نصف ساعة\n\n2\n00:30:10,000 --> 00:30:20,000\nالسطر التالي\n";
  await host.getByTestId("subtitle-file").setInputFiles({ name: "long.srt", mimeType: "application/x-subrip", buffer: Buffer.from(srt) });

  await tapFullscreen(host);
  await tapFullscreen(guest);
  const controls = host.getByTestId("immersive-controls");
  const seek = controls.getByRole("slider", { name: "Seek" });
  await expect(seek).toBeEnabled({ timeout: 10_000 });
  await seek.fill("1802");
  await seek.blur();
  await controls.getByRole("button", { name: "Play" }).tap();
  for (const page of [host, guest]) {
    await expect(page.getByTestId("subtitle-text")).toHaveText("بعد نصف ساعة", { timeout: 15_000 });
  }
  await expect.poll(async () => Math.abs(await gap(host, guest)), { timeout: 15_000, intervals: [500] }).toBeLessThan(0.4);

  await controls.getByRole("button", { name: "Pause" }).tap();
  await expect.poll(async () => (await info(guest)).paused, { timeout: 5000 }).toBe(true);
  await seek.fill("1810.2");
  await seek.blur();
  await expect(guest.getByTestId("subtitle-text")).toHaveText("السطر التالي", { timeout: 10_000 });
  // +0.5 s delay, set from the panel under the player: the earlier line shows again for everyone.
  await host.getByTestId("subtitle-later").evaluate((b: HTMLButtonElement) => b.click());
  for (const page of [host, guest]) {
    await expect(page.getByTestId("subtitle-text")).toHaveText("بعد نصف ساعة", { timeout: 10_000 });
  }
  await controls.getByRole("button", { name: "Play" }).tap();
  await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(false);
  await expect.poll(async () => Math.abs(await gap(host, guest)), { timeout: 15_000, intervals: [500] }).toBeLessThan(0.4);
  await expect(guest.getByTestId("screen")).toHaveAttribute("data-immersive", "true");
  await ctx.close();
});

test("desktop fullscreen still uses the Fullscreen API on the player box", async ({ context }) => {
  const host = await context.newPage();
  await hostRoom(host);
  await host.getByTestId("subtitle-file").setInputFiles({ name: "arabic.srt", mimeType: "application/x-subrip", buffer: Buffer.from(SRT) });
  await act(host, { seek: 2 });

  await host.getByTestId("fullscreen").click();
  await expect.poll(() => host.evaluate(() => document.fullscreenElement?.getAttribute("data-testid"))).toBe("screen");
  await expect(host.getByTestId("screen")).not.toHaveAttribute("data-immersive");
  await expect(host.getByTestId("immersive-controls")).toHaveCount(0);
  expect(await video(host).evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
  await expect(host.getByTestId("subtitle-text").locator("p")).toHaveText("مرحبا بكم في الحفلة", { timeout: 10_000 });

  // The page's own button sits under the fullscreen player; leave it the way Escape does.
  await host.evaluate(() => document.exitFullscreen());
  await expect.poll(() => host.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(host.getByTestId("fullscreen")).toHaveText("Fullscreen");
});

test("Watch Party installs as a Home Screen web app", async ({ page }) => {
  await page.goto("/");
  const manifest = await page.locator('link[rel="manifest"]').getAttribute("href");
  const res = await page.request.get(manifest!);
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ name: "Watch Party", display: "standalone", start_url: "/" });
  for (const icon of (await res.json()).icons as { src: string }[]) expect((await page.request.get(icon.src)).ok()).toBe(true);
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect((await page.request.get(touch!)).ok()).toBe(true);
  await expect(page.locator('meta[name="mobile-web-app-capable"], meta[name="apple-mobile-web-app-capable"]')).toHaveCount(1);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
});

test("Movi failures say why: blocked byte-range access, or a missing file", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("create-room").click();
  await page.waitForURL(/\/room\//);

  // Another origin that serves the bytes (with Range) but no CORS headers: <video> may load it,
  // Movi may not read it. Locally that's the same server under 127.0.0.1; deployed runs need a
  // public link of that kind in E2E_NOCORS_URL (an AVI/MKV the browser itself can't decode).
  const noCors = process.env.E2E_BASE_URL ? process.env.E2E_NOCORS_URL : "http://127.0.0.1:3100/__test__/clip.avi?sig=abc";
  if (noCors) {
    await paste(page, noCors);
    // Locally the link has no redirect; live (archive.org) the hop and the file's server both lack
    // CORS. Either way the resolver finds the final server refusing the page, and names it.
    const finalHost = process.env.E2E_BASE_URL ? "[\\w.-]+" : "127\\.0\\.0\\.1";
    await expect(page.getByTestId("media-error")).toHaveText(
      new RegExp(`^The video's server \\(${finalHost}\\) blocks browser streaming of this format\\. On desktop Chrome, Edge or Brave, the WatchParty CORS Unlocker extension fixes this; phone browsers can't play this link\\.$`),
      { timeout: 40_000 },
    );
    expect(await page.evaluate(() => (window as unknown as { __watchparty: { player(): { failureReason?(): string | null } } }).__watchparty.player().failureReason?.())).toBe(
      "FINAL_CDN_CORS_BLOCKED",
    );
  }

  await paste(page, "/__test__/missing.mkv");
  await expect(page.getByTestId("media-error")).toHaveText("The video link wasn't found. It may have expired.", { timeout: 30_000 });
});

/**
 * A debrid-style link on another origin: /hop/<file> answers 302 without CORS headers and
 * points at /cors/<file> (CORS + Range) or, for /hop-nocors/<file>, at /nocors/<file> (Range only).
 * Records every request so the test can check the app server only ever asked for one byte.
 */
const MEDIA_PORT = 3200;
const SIGNED = "?X-Expires=1760000000&X-Signature=Ab%2Bc%2F%3D~z";
const mediaLog: { path: string; range: string; ua: string; bytes: number }[] = [];
let mediaServer: Server | null = null;

function startMediaServer() {
  return new Promise<void>((done) => {
    mediaServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const [, kind, name] = /^\/([a-z-]+)\/([\w.-]+)$/.exec(url.pathname) ?? [];
      const entry = { path: req.url ?? "", range: req.headers.range ?? "", ua: req.headers["user-agent"] ?? "", bytes: 0 };
      mediaLog.push(entry);
      if (kind === "hop" || kind === "hop-nocors") {
        // Relative Location, like many CDNs send; the signed query must survive untouched.
        res.writeHead(302, { Location: `../${kind === "hop" ? "cors" : "nocors"}/${name}${SIGNED}` }).end();
        return;
      }
      if ((kind !== "cors" && kind !== "nocors") || url.search !== SIGNED) return void res.writeHead(404).end();
      let file: Buffer;
      try {
        file = readFileSync(resolvePath("public/__test__", name));
      } catch {
        return void res.writeHead(404).end();
      }
      const cors = kind === "cors" ? { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range, Content-Length" } : {};
      if (req.method === "OPTIONS") return void res.writeHead(204, { ...cors, "Access-Control-Allow-Headers": "range" }).end();
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      const start = m ? Number(m[1]) : 0;
      const end = m?.[2] ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
      const body = file.subarray(start, end + 1);
      entry.bytes = body.length;
      res.writeHead(m ? 206 : 200, {
        ...cors,
        "Content-Type": name.endsWith(".mkv") ? "video/x-matroska" : "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Content-Length": String(body.length),
        ...(m ? { "Content-Range": `bytes ${start}-${end}/${file.length}` } : {}),
      });
      res.end(body);
    }).listen(MEDIA_PORT, "127.0.0.1", done);
  });
}

test.describe("redirect resolver", () => {
  test.skip(!!process.env.E2E_BASE_URL, "needs the local media server");
  test.beforeAll(startMediaServer);
  test.afterAll(() => new Promise<void>((done) => (mediaServer ? mediaServer.close(() => done()) : done())));
  test.beforeEach(() => void (mediaLog.length = 0));

  /** What the app's server (not the browser) fetched: never more than the one byte it asks for. */
  const serverRequests = () => mediaLog.filter((r) => !/Chrome|HeadlessChrome/.test(r.ua));

  test("a redirect hop without CORS is skipped: Movi plays the final URL, seeks, and the guest follows", async ({ browser, context }) => {
    const host = await context.newPage();
    const link = `http://localhost:${MEDIA_PORT}/hop/long.mkv`;
    const roomUrl = await hostRoom(host, link);
    await expect(host.locator('[data-provider="movi"]')).toHaveCount(1);
    const guest = await guestPage(browser, context);
    await guest.goto(roomUrl);
    await expect(guest.locator('[data-provider="movi"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 30_000 });

    await host.getByTestId("movi-play").click();
    await expect.poll(async () => (await info(guest)).paused, { timeout: 10_000 }).toBe(false);
    await act(host, { seek: 30 * 60 });
    await expect.poll(async () => (await info(guest)).t, { timeout: 15_000 }).toBeGreaterThan(30 * 60);
    await expect.poll(async () => Math.abs(await gap(host, guest)), { timeout: 15_000, intervals: [500] }).toBeLessThan(0.4);
    console.log(`resolver: seek gap ${(await gap(host, guest)).toFixed(3)}s`);

    // The browser read the final URL with the signed query intact.
    expect(mediaLog.some((r) => r.path === `/cors/long.mkv${SIGNED}` && /Chrome/.test(r.ua) && r.bytes > 1)).toBe(true);
    // The app server only followed headers: one byte per hop at most, never the video.
    const fromServer = serverRequests();
    expect(fromServer.length).toBeGreaterThan(0);
    for (const r of fromServer) {
      expect(r.range).toBe("bytes=0-0");
      expect(r.bytes).toBeLessThanOrEqual(1);
    }
  });

  test("a final server without CORS is named, not reported as a format problem", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("create-room").click();
    await page.waitForURL(/\/room\//);
    await paste(page, `http://localhost:${MEDIA_PORT}/hop-nocors/clip.avi`);
    await expect(page.getByTestId("media-error")).toHaveText(
      "The video's server (localhost) blocks browser streaming of this format. On desktop Chrome, Edge or Brave, the WatchParty CORS Unlocker extension fixes this; phone browsers can't play this link.",
      { timeout: 40_000 },
    );
    // One resolver pass: the hop was followed once by the server, not in a loop.
    expect(serverRequests().filter((r) => r.path.startsWith("/hop-nocors/"))).toHaveLength(1);
  });

  test("with the CORS Unlocker extension, the same final server plays", async () => {
    const { chromium } = await import("@playwright/test");
    const ext = resolvePath("extensions/cors-unlocker");
    const ctx = await chromium.launchPersistentContext("", {
      // Extensions need full Chromium in new headless mode, not the headless shell.
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
      headless: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"],
      baseURL: `http://localhost:3100`,
    });
    try {
      const isExt = (w: { url(): string }) => w.url().startsWith("chrome-extension://");
      const worker = ctx.serviceWorkers().find(isExt) ?? (await ctx.waitForEvent("serviceworker", { predicate: isExt }));
      type Chrome = { chrome?: { storage?: { local: { set(v: object): Promise<void> } } } };
      // The worker can be reported before its extension APIs are bound.
      await expect.poll(() => worker.evaluate(() => !!(globalThis as Chrome).chrome?.storage)).toBe(true);
      await worker.evaluate(() => (globalThis as Chrome).chrome!.storage!.local.set({ cdnDomains: ["localhost"] }));
      const page = await ctx.newPage();
      await page.goto("/");
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.watchpartyCorsUnlocker ?? "")).not.toBe("");
      await page.getByTestId("create-room").click();
      await page.waitForURL(/\/room\//);
      await paste(page, `http://localhost:${MEDIA_PORT}/hop-nocors/clip.avi`);
      await expect(page.locator('[data-provider="movi"]')).toHaveCount(1, { timeout: 30_000 });
      await expect.poll(async () => (await info(page)).ready, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
      await expect(page.getByTestId("media-error")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});

/**
 * Deployed runs: a real redirect whose hop sends no CORS while the file's server does
 * (E2E_REDIRECT_URL, e.g. a github.com/.../raw/... MKV that lands on raw.githubusercontent.com).
 */
test("live: a redirect hop without CORS plays on the final URL and the guest follows", async ({ browser, context }) => {
  const link = process.env.E2E_REDIRECT_URL;
  test.skip(!process.env.E2E_BASE_URL || !link, "needs E2E_REDIRECT_URL on a deployed run");
  const host = await context.newPage();
  const resolved: unknown[] = [];
  host.on("response", async (r) => {
    if (r.url().endsWith("/api/media/resolve")) resolved.push(await r.json().catch(() => null));
  });
  const roomUrl = await hostRoom(host, link!);
  await expect(host.locator('[data-provider="movi"]')).toHaveCount(1);
  expect(resolved).toEqual([expect.objectContaining({ ok: true, redirected: true, supportsRange: true })]);
  console.log(`live resolver: ${new URL(link!).hostname} -> ${new URL((resolved[0] as { finalUrl: string }).finalUrl).hostname}`);
  const guest = await guestPage(browser, context);
  await guest.goto(roomUrl);
  await expect(guest.locator('[data-provider="movi"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 30_000 });
  await host.getByTestId("movi-play").click();
  await expect.poll(async () => (await info(guest)).paused, { timeout: 15_000 }).toBe(false);
  await act(host, { seek: 40 });
  await expect.poll(async () => Math.abs(await gap(host, guest)), { timeout: 15_000, intervals: [500] }).toBeLessThan(0.4);
  console.log(`live resolver: seek gap ${(await gap(host, guest)).toFixed(3)}s`);
});

/**
 * Deployed runs with SubDL configured (E2E_SUBDL=1): the real search for a sanitized episode file
 * name finds real Arabic subtitles, applies one for the right episode, and guests get it.
 */
test("live: Find Arabic subtitles for Silo S03E01 applies a real SubDL subtitle for that episode", async ({ browser, context }) => {
  test.skip(!process.env.E2E_BASE_URL || !process.env.E2E_SUBDL, "needs a deployed run with SubDL configured");
  type Found = { autoSelect: boolean; results: { release: string; confidence: string; feature: { season: number | null; episode: number | null } }[]; errors: unknown[] };
  const host = await context.newPage();
  const roomUrl = await hostRoom(host, "/__test__/Silo%20S03E01.mp4");
  const guest = await guestPage(browser, context);
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready", { timeout: 20_000 });
  await act(host, { seek: 13.2 });

  const searched = host.waitForResponse((r) => r.url().endsWith("/api/subtitles/search"));
  await host.getByTestId("subtitle-find").click();
  const found = (await (await searched).json()) as Found;
  console.log(`live SubDL: ${found.results.length} results, auto ${found.autoSelect}, errors ${JSON.stringify(found.errors)}`);
  expect(found.errors).toEqual([]);
  expect(found.results.length).toBeGreaterThan(0);
  // Every offered subtitle, and so the one applied automatically, is for S03E01.
  for (const r of found.results) expect([r.feature.season, r.feature.episode]).toEqual([3, 1]);
  expect(found.autoSelect).toBe(true);

  // The first cue of the episode (00:00:12,804 --> 00:00:13,805) shows for both.
  for (const page of [host, guest]) {
    await expect(page.getByTestId("subtitle-name")).toHaveText(found.results[0].release, { timeout: 15_000 });
    await expect(page.getByTestId("subtitle-text")).toContainText("فيتاميناتك", { timeout: 15_000 });
  }

  // The shared delay moves it for everyone: +0.5s, and the cue now covers 13.9s.
  await host.getByTestId("subtitle-later").click();
  await expect(guest.getByTestId("subtitle-offset")).toHaveText("+0.5s");
  await act(host, { seek: 13.9 });
  await expect(guest.getByTestId("subtitle-text")).toContainText("فيتاميناتك", { timeout: 10_000 });

  // Another episode's search never offers S03E01.
  const other = (await (
    await host.request.post("/api/subtitles/search", { data: { kind: "file", url: "https://cdn.example/d/Silo%20S03E02.mp4" } })
  ).json()) as Found;
  console.log(`live SubDL S03E02: ${other.results.length} results`);
  for (const r of other.results) expect([r.feature.season, r.feature.episode]).toEqual([3, 2]);
});
