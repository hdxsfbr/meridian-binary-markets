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
import { formatStrike } from "../src/lib/format";
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

  test("flow 6: minting pairs then selling some Yes shows the exact hand-computed cost basis and realized P&L", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const seed = loadSeed();
    // A dedicated strike on the open ticker's own ladder (`seed.ts`'s
    // `pnlMarket`, with its own resting bid from a maker identity never
    // loaded into any browser) -- never the strike `seed.openMarket`
    // points at, so this test's mint/sell never touches the book
    // `trade.spec.ts`'s flows (and its order-book perspective test) depend
    // on, regardless of which spec file runs first.
    const strikeLabel = formatStrike(BigInt(seed.pnlMarket.strike));

    await connectAs(page, seed.taker.secretKeyBase58);
    await page.goto("/portfolio");
    await clickConnect(page);

    // --- Step 1: mint 4 pairs on the dedicated pnl market ("Your quotes"
    // panel's "Pairs to mint" form, same one admin.spec.ts scopes by
    // `hasText: "Pairs to mint"`). The form's "Market" select defaults to
    // the first open market in ticker/strike order, which is not
    // necessarily this strike, so pick it explicitly. ---
    const mintForm = page.locator("form").filter({ hasText: "Pairs to mint" });
    await mintForm.getByLabel("Market").selectOption({ label: `${seed.pnlMarket.ticker} ${strikeLabel}` });
    await mintForm.getByLabel("Pairs to mint").fill("4");
    await mintForm.getByRole("button", { name: "Mint pair", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Minted" })).toBeVisible({ timeout: 20_000 });

    // --- Step 2: sell 3 of those 4 Yes tokens, market order, into the
    // dedicated maker's resting $0.40 bid (`seed.ts`'s `PNL_MAKER_BID_PRICE`
    // x `PNL_MAKER_BID_QTY` = 5). ---
    await page.goto(`/trade/${seed.pnlMarket.ticker}`);
    await page.locator("tr", { hasText: strikeLabel }).first().click();
    await page.getByRole("button", { name: "Market", exact: true }).click();
    const qtyInput = page.getByLabel("Quantity");
    await qtyInput.fill("3");
    await page.getByRole("button", { name: "Sell Yes", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sold" })).toBeVisible({ timeout: 20_000 });

    // --- Hand computation, following packages/sdk/src/pnl.ts's average-cost rules ---
    //
    // Mint 4 pairs (`Minted`): the $1.00-per-pair cost splits 50/50 across
    // the Yes and No legs (HALF_USDC), so:
    //   costYes(before) = 4 * $0.50 = $2.00   (yes = 4)
    //   costNo           = 4 * $0.50 = $2.00   (no  = 4, untouched below)
    //
    // Sell 3 Yes @ $0.40 into the resting bid (`Fill`, a Yes disposal):
    //   proceeds     = 3 * $0.40                          = $1.20
    //   costRemoved  = costYes(before) * soldQty / yesQty
    //                = $2.00 * 3 / 4                      = $1.50
    //   realized P&L = proceeds - costRemoved = $1.20 - $1.50 = -$0.30
    //   costYes(after) = $2.00 - $1.50 = $0.50
    //
    // costBasisMicro (Yes leg + No leg) = $0.50 + $2.00 = $2.50
    // realizedPnlMicro                  = -$0.30
    const EXPECTED_ROW_TEXT = "Cost basis $2.50 · Realized P&L -$0.30";

    await page.goto("/portfolio");
    // Wait for both the page-level and the per-row "still syncing" copy to
    // clear before asserting -- `usePositions`' event-index replay is what
    // computes cost basis/P&L, and asserting against it mid-sync would
    // read a partial fold.
    await expect(page.getByText("Updating your trade history…", { exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText("Cost basis updating…", { exact: true })).toHaveCount(0, { timeout: 30_000 });

    // Scoped to the "Positions" section specifically: `PositionRow`'s own
    // heading renders the ticker/strike as one text node followed by a
    // *nested* "· <trading day>" span (so its full text is never exactly
    // "AAPL $330", only ever a string starting with it -- an `exact: true`
    // match here never matches anything), and "Your quotes"' own summary
    // table repeats the same ticker/strike text in a visible `<td>`
    // elsewhere on the page, so an unscoped substring search would be
    // ambiguous between the two.
    const positionsSection = page.locator("section", { hasText: "Positions" });
    const heading = positionsSection.getByText(`${seed.pnlMarket.ticker} ${strikeLabel}`);
    const row = heading.locator("xpath=ancestor::div[contains(@class,'rounded')][1]");
    await expect(row.getByText(EXPECTED_ROW_TEXT, { exact: true })).toBeVisible({ timeout: 20_000 });
  });
});
