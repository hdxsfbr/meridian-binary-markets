import { defineConfig, devices } from "@playwright/test";

/**
 * Config for the Wave 7 browser smoke suite (tasks.md T066/T075/T080):
 * flows 1-5 from contracts/frontend.md, run against an already-running
 * `next dev` on :3000 and an already-running local validator -- both
 * started by `make test-web` before this ever runs, so there is no
 * `webServer` block here (Playwright only ever drives what's already up).
 *
 * `globalSetup` seeds the two markets this suite needs (one open, one
 * already settled) directly against the chain, then writes their
 * addresses/keypairs to a fixed path the spec files read back.
 *
 * Timeouts are generous: every flow confirms at least one localnet
 * transaction, and trade.spec.ts's book-sync assertion polls a second
 * browser context for up to a second without a reload.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
