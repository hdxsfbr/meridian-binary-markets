/**
 * Shared helpers for the Wave 7 Playwright smoke suite's spec files:
 * reading back `seed.ts`'s fixture JSON, and injecting the per-test E2E
 * wallet secret (`web/src/lib/e2e-wallet.ts` reads
 * `window.__MERIDIAN_E2E_SECRET__`, set here via `page.addInitScript` before
 * the app's own scripts run, so different specs can drive different
 * identities -- e.g. the real admin keypair in `admin.spec.ts` -- against
 * the one `next dev` process the whole suite shares).
 */

import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { SEED_PATH, type SeedResult } from "./seed";

export function loadSeed(): SeedResult {
  return JSON.parse(readFileSync(SEED_PATH, "utf8")) as SeedResult;
}

/** Sets the browser wallet's identity for every page load in this test, then opens the wallet modal and connects. */
export async function connectAs(page: Page, secretBase58: string): Promise<void> {
  await page.addInitScript((secret: string) => {
    (window as unknown as { __MERIDIAN_E2E_SECRET__?: string }).__MERIDIAN_E2E_SECRET__ = secret;
  }, secretBase58);
}

/**
 * Clicks the Nav's wallet button, then the "Test Wallet" entry in the modal
 * it opens, and waits for connection. Matched by a leading-"Test Wallet"
 * regex rather than an exact string: the modal's list item renders a
 * "Detected" badge as a sibling text node inside the same `<button>`
 * (`Test Wallet<span>Detected</span>`), so the button's accessible name is
 * "Test WalletDetected", not "Test Wallet" alone.
 */
export async function clickConnect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Select Wallet", exact: true }).click();
  await page.getByRole("button", { name: /^Test Wallet/ }).click();
  // The multi-button's label swaps from "Select Wallet" to the connected wallet's truncated address.
  await expect(page.getByRole("button", { name: "Select Wallet", exact: true })).toHaveCount(0, { timeout: 15_000 });
}
