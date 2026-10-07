/**
 * Playwright smoke flows 1 and 4 (contracts/frontend.md, tasks.md T080):
 *
 *   1. connect wallet -> see balance
 *   4. settled market -> redeem -> balance increases
 *
 * Both run as the taker identity from `seed.ts`, which already holds a
 * minted pair on the seeded settled market (so flow 4 needs no trading step
 * of its own -- it just redeems the winning side).
 */

import { test, expect } from "@playwright/test";
import { clickConnect, connectAs, loadSeed } from "./fixtures";

/** "$1,234.56" -> 1234.56; this page never uses thousands separators, but tolerate them anyway. */
function parseUsd(text: string): number {
  const match = text.match(/-?\$[\d,]+\.\d{2}/);
  if (!match) {
    throw new Error(`parseUsd: "${text}" does not look like a USD amount`);
  }
  return Number(match[0].replace(/[$,]/g, ""));
}

test.describe("portfolio", () => {
  test("flow 1: connecting a wallet shows its USDC balance", async ({ page }) => {
    const seed = loadSeed();
    await connectAs(page, seed.taker.secretKeyBase58);
    await page.goto("/portfolio");

    await expect(page.getByText("Connect a wallet to see your portfolio.", { exact: true })).toBeVisible();

    await clickConnect(page);

    // Scoped to the USDC balance section specifically (`data-testid`
    // added in `portfolio/page.tsx`), not just the first dollar-looking
    // string on the page -- the Realized P&L row renders in the same
    // format and can appear first while the balance itself is still
    // loading ("—"), which would otherwise let this assertion pass
    // against the wrong element. Wait for the exact funded amount this
    // suite's `seed.ts` funds every demo user with, not just "visible".
    const balance = page.getByTestId("usdc-balance");
    await expect(balance).toHaveText(/^\$-?[\d,]+\.\d{2}$/, { timeout: 20_000 });
    const funded = parseUsd(await balance.innerText());
    // `seed.ts` funds the taker with `DEMO_USER_INITIAL_USDC` (1,000 USDC)
    // but then mints `settledPairsMinted` pairs on the settled market
    // (1 USDC collateral per pair) before this test ever runs, so the
    // balance by the time the page loads is already net of that mint.
    const expectedFunded = 1_000 - Number(seed.taker.settledPairsMinted);
    expect(funded).toBe(expectedFunded);
  });

  test("flow 4: redeeming a settled market's winning side increases the USDC balance by exactly the winning quantity", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const seed = loadSeed();
    await connectAs(page, seed.taker.secretKeyBase58);
    await page.goto("/portfolio");
    await clickConnect(page);

    const balanceLocator = page.getByTestId("usdc-balance");
    await expect(balanceLocator).toHaveText(/^\$-?[\d,]+\.\d{2}$/, { timeout: 20_000 });
    const before = parseUsd(await balanceLocator.innerText());

    // No reload/reconnect retry: a loading error here is a real failure
    // this test should surface, not something to paper over by reloading
    // the page (which would also race the wallet-adapter's own
    // autoConnect against this test's explicit `clickConnect`). Rely on
    // `usePositions`' own 30s retry interval instead, and fail outright if
    // it ever surfaces the error text.
    const positionsError = page.getByText("Could not load your positions. Retrying…", { exact: true });
    await expect(positionsError).toHaveCount(0);
    const redeemButton = page.getByRole("button", { name: "Redeem winning", exact: true });
    await expect(redeemButton).toBeVisible({ timeout: 60_000 });
    await expect(positionsError).toHaveCount(0);

    // Alphabetically, this spec file runs before `trade.spec.ts` mutates the taker's
    // open-market position, so the seeded settled market is the only redeemable
    // position on the page right now and this button is unambiguous.
    await redeemButton.click();

    // Exactly `settledPairsMinted` USDC: `seed.ts` mints the taker a pair
    // of that size on the settled market, and settlement pays 1 USDC per
    // contract on the winning side.
    const expectedIncrease = Number(seed.taker.settledPairsMinted);

    // The portfolio page's USDC balance only re-polls every 30s (`portfolio/page.tsx`'s
    // `loadBalance` interval; redeeming doesn't trigger an immediate re-fetch of it),
    // so this has to outlast one full interval tick, not just the transaction's confirmation.
    await expect(async () => {
      const after = parseUsd(await balanceLocator.innerText());
      expect(after - before).toBeCloseTo(expectedIncrease, 6);
    }).toPass({ timeout: 40_000 });
  });
});
