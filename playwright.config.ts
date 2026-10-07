import { defineConfig } from "@playwright/test";

const PORT = 3100;
/** E2E_BASE_URL points the suite at a deployed app (e.g. a Vercel Preview) instead of a local server. */
const remote = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  workers: 1,
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: remote || `http://localhost:${PORT}`,
    storageState: process.env.E2E_VERCEL_SHARE ? "test-results/.vercel-auth.json" : undefined,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // Lets the guest tab play without a click; the gesture overlay is covered separately.
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: remote ? undefined : {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/time`,
    reuseExistingServer: true,
    timeout: 180_000,
    // Local (BroadcastChannel) mode by default so tests don't depend on a Supabase project.
    // E2E_SUPABASE=1 keeps the Supabase env vars and runs the same suite over Realtime.
    env: process.env.E2E_SUPABASE
      ? {}
      : { NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" },
  },
});
