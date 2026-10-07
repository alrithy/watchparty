import { chromium, type FullConfig } from "@playwright/test";

/**
 * Remote runs against a protected Vercel Preview: open the share link once and
 * save the auth cookie for every test context (E2E_VERCEL_SHARE = share token).
 */
export default async function globalSetup(config: FullConfig) {
  const token = process.env.E2E_VERCEL_SHARE;
  const baseURL = process.env.E2E_BASE_URL;
  if (!token || !baseURL) return;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  await page.goto(`${baseURL}/?_vercel_share=${token}`);
  await page.context().storageState({ path: config.projects[0].use.storageState as string });
  await browser.close();
}
