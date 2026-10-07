import { expect, test, type Page } from "@playwright/test";

const CLIP = "/__test__/clip.webm";

type VideoInfo = { t: number; paused: boolean; rate: number; ready: number };

const info = (page: Page) =>
  page.locator('[data-testid="video"]').evaluate((v: HTMLVideoElement): VideoInfo => ({
    t: v.currentTime,
    paused: v.paused,
    rate: v.playbackRate,
    ready: v.readyState,
  }));

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
  await page.getByTestId("source-url").fill(new URL("/api/time", page.url()).toString());
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
  const guest = await (process.env.E2E_SUPABASE ? await browser.newContext() : context).newPage();
  await guest.goto(roomUrl);
  await expect(host.getByTestId("participant-guest")).toContainText("Ready");
  await expect(guest.getByTestId("participant-host")).toBeVisible();
  await guest.close();
  await expect(host.getByTestId("participant-guest")).toHaveCount(0, { timeout: 15_000 });
});

test("guest recovers after a network drop", async ({ browser }) => {
  test.skip(!process.env.E2E_SUPABASE, "the local fallback has no network to drop");
  const host = await (await browser.newContext()).newPage();
  const roomUrl = await hostRoom(host);
  const guestCtx = await browser.newContext();
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
