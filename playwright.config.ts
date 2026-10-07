import { defineConfig } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // Lets the guest tab play without a click; the gesture overlay is covered separately.
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/time`,
    reuseExistingServer: true,
    timeout: 180_000,
    // Force local (BroadcastChannel) mode so tests don't depend on a Supabase project.
    env: { NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" },
  },
});
