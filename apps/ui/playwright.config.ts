import { defineConfig } from "@playwright/test"

/*
 * T1 (docs/LOCAL-APP.md "Test tiers"): the SPA in headless chromium against
 * the local server. Every spec keeps the server behind page.route /
 * page.routeWebSocket so the same specs run against the foundation lane's
 * `bun src/bun/serve.ts` once it replaces the webServer command below; until
 * then the built SPA is served by vite preview on the contract's port.
 *
 * `--configLoader runner`: vite.config.ts reaches the smithers-shared
 * workspace source (see the note at the top of that file).
 */
const PORT = 47311
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: "e2e/playwright",
  testMatch: /.*\.spec\.ts$/,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "reports/playwright",
  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: {
    // `--host 127.0.0.1`: vite preview binds [::1] alone by default, and the contract's origin is 127.0.0.1.
    command: `vite build --configLoader runner && vite preview --host 127.0.0.1 --port ${PORT} --strictPort --configLoader runner`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe"
  }
})
