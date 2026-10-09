import { test, expect } from "@playwright/test";

/**
 * Client-side privacy and UX test; all RD requests mocked. It never uses a real key,
 * calls an external provider, or streams media bytes.
 */
test("RD compatibility lab can discover downloads and select a Safari HLS rendition without leaking the key", async ({ page }) => {
  const token = "E2E_NOT_REAL_RD_KEY_987654";
  const recorded: Array<{ url: string; action: string; token: string; id?: string }> = [];
  await page.route("**/api/rd/compat", async (route) => {
    const post = route.request().postDataJSON() as { action: string; token: string; id?: string };
    recorded.push({ url: route.request().url(), ...post });
    if (post.action === "list") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ downloads: [{ id: "RDABCDEF123", name: "Silo.S03E01.mkv", size: 12345 }] }),
      });
    }
    return route.fulfill({
      status: 200, contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ result: { durationSeconds: 3000, filename: "Silo.S03E01.mkv", variants: [
        { quality: "1080", url: "https://cdn.example.test/hls/master.m3u8?secret=SIGNED" },
      ] } }),
    });
  });
  await page.goto("/rd-compat");
  await expect(page.getByRole("heading", { name: /Real-Debrid/ })).toBeVisible();
  await page.getByLabel("Your RD API key (not stored)").fill(token);
  await page.getByRole("button", { name: "List recent downloads" }).click();
  await expect(page.getByRole("option", { name: "Silo.S03E01.mkv" })).toHaveCount(1);
  await page.getByRole("button", { name: "Find Apple HLS renditions" }).click();
  await expect(page.getByText("Provider duration: 3000.0 seconds", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Play 1080" }).click();
  await expect(page.locator("video")).toHaveAttribute("src", /master\.m3u8/);
  expect(page.url()).not.toContain(token);
  expect(recorded).toHaveLength(2);
  expect(recorded.every(r => r.token === token && !r.url.includes(token))).toBe(true);
  expect(recorded[1].id).toBe("RDABCDEF123");
  await page.getByTestId("apple-control-hls").click();
  await expect(page.locator("video")).toHaveAttribute("src", /devstreaming-cdn\.apple\.com.*master\.m3u8/);
  await expect(page.getByTestId("rd-playback-diagnostics")).toContainText("Apple HLS control");
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByLabel("Your RD API key (not stored)")).toHaveValue("");
  await expect(page.locator("video")).toHaveCount(0);
});
