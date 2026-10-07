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

const video = (page: Page) => page.locator('[data-testid="video"]');

test("host and guest stay in sync across play, pause, seek, drift and reloads", async ({ context }) => {
  const host = await context.newPage();
  await host.goto("/");
  await host.getByTestId("create-room").click();
  await host.waitForURL(/\/room\/[A-Z0-9]{6}$/);
  const roomUrl = new URL(host.url()).pathname;

  await host.getByTestId("source-url").fill(new URL(CLIP, host.url()).toString());
  await host.getByTestId("load-source").click();
  await expect.poll(async () => (await info(host)).ready).toBeGreaterThanOrEqual(3);

  // Guest joins through the invite link in a separate tab.
  const guest = await context.newPage();
  await guest.goto(roomUrl);
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
