/**
 * Playwright smoke flows 2 and 3 (contracts/frontend.md, tasks.md T066):
 *
 *   2. place a limit Buy Yes -> appears in book without reload
 *   3. Buy No market -> wallet holds only No
 *
 * Both run against `seed.ts`'s open market (`AAPL`'s ATM strike), which has
 * a maker resting an Ask at $0.60 and a Bid at $0.40. Flow 2's limit order
 * is priced at $0.30 -- deliberately *below* the maker's $0.40 bid so it
 * never becomes the book's best bid itself; flow 3's market Buy No (qty 2,
 * well under the maker's resting qty of 5) then crosses the maker's $0.40
 * bid, never reaching the taker's own resting $0.30 order. Keeping the
 * taker's own limit order strictly worse than the maker's avoids a
 * self-trade that would otherwise land the taker's own IOC sell against
 * their own resting bid instead of the maker's.
 */

import { test, expect } from "@playwright/test";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, noMintPda, yesMintPda } from "@meridian/sdk";
import { associatedTokenAddress } from "../src/lib/ata";
import { formatStrike } from "../src/lib/format";
import { clickConnect, connectAs, loadSeed } from "./fixtures";

const FLOW2_PRICE = "0.30";
const FLOW3_QTY = "2";
const FLOW3_QTY_BIGINT = BigInt(FLOW3_QTY);
/** Yes/No mints have 6 decimals (`usePosition.ts`'s `BASE_UNITS_PER_CONTRACT`); one contract is this many base units. */
const BASE_UNITS_PER_CONTRACT = 1_000_000n;

/** Reads a token account's raw base-unit balance via RPC; an absent ATA (never touched) reads as 0n, matching `usePosition`'s own tolerance. */
async function rpcTokenBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const result = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(result.value.amount);
  } catch {
    return 0n;
  }
}

test.describe("trade", () => {
  test("flow 2: a limit Buy Yes appears in a second browser context's book within 1s, no reload", async ({ browser }) => {
    test.setTimeout(90_000);
    const seed = loadSeed();
    const strikeLabel = formatStrike(BigInt(seed.openMarket.strike));
    const url = `/trade/${seed.openMarket.ticker}`;

    const takerContext = await browser.newContext();
    const takerPage = await takerContext.newPage();
    await connectAs(takerPage, seed.taker.secretKeyBase58);
    await takerPage.goto(url);
    await clickConnect(takerPage);
    await takerPage.locator("tr", { hasText: strikeLabel }).first().click();

    // A second, read-only context: already on the same page, before the
    // order is placed, so the book update it sees can never be attributed
    // to a reload.
    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(url);
    await viewerPage.locator("tr", { hasText: strikeLabel }).first().click();
    // `.last()`: the page has two `<table>`s (the strike list, then the order
    // book), and the seeded maker's $0.60 ask shows up in *both* -- the strike
    // list's own "Yes" column for this row, and the order book's "Ask price"
    // column. Only the order book (the second, later table in document order)
    // is what this flow is actually about.
    await expect(viewerPage.locator("table").last().getByText("$0.60", { exact: true })).toBeVisible();

    // Start the viewer's observation *before* the order is even placed, so
    // whatever moment it actually notices the new $0.30 row is attributable
    // only to the book update, never to time already spent waiting on the
    // placing context's own confirmation. Recorded as a timestamp rather
    // than a fixed assertion timeout, so a book update the viewer already
    // saw before the order was confirmed can't produce a false pass.
    let seenAtMs = 0;
    const viewerSeen = viewerPage
      .locator("table")
      .last()
      .getByText("$0.30", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => {
        seenAtMs = Date.now();
      });

    const qtyInput = takerPage.getByLabel("Quantity");
    const priceInput = takerPage.getByLabel("Price ($)");
    await takerPage.getByRole("button", { name: "Limit", exact: true }).click();
    await qtyInput.fill("1");
    await priceInput.fill(FLOW2_PRICE);
    await takerPage.getByRole("button", { name: "Buy Yes", exact: true }).click();

    // Success clears the price and resets quantity to 1 (TradePanel's
    // `execute`); a failed send leaves them as-is and surfaces red error text
    // instead. The price field is the one that visibly changes here, and it
    // resolves at the moment the transaction is confirmed -- the reference
    // point the 1s latency budget is measured from.
    await expect(priceInput).toHaveValue("", { timeout: 20_000 });
    const confirmedAtMs = Date.now();

    await viewerSeen;
    expect(seenAtMs).toBeGreaterThan(0);
    const latencyMs = seenAtMs - confirmedAtMs;
    expect(latencyMs).toBeLessThanOrEqual(1_000);

    await takerContext.close();
    await viewerContext.close();
  });

  test("flow 3: Buy No market against the seeded maker bid leaves the wallet holding only No", async ({ page }) => {
    test.setTimeout(90_000);
    const seed = loadSeed();
    const strikeLabel = formatStrike(BigInt(seed.openMarket.strike));

    await connectAs(page, seed.taker.secretKeyBase58);
    await page.goto(`/trade/${seed.openMarket.ticker}`);
    await clickConnect(page);
    await page.locator("tr", { hasText: strikeLabel }).first().click();

    await page.getByRole("button", { name: "Market", exact: true }).click();
    const qtyInput = page.getByLabel("Quantity");
    await qtyInput.fill(FLOW3_QTY);
    await page.getByRole("button", { name: "Buy No", exact: true }).click();
    await expect(qtyInput).toHaveValue("1", { timeout: 20_000 });

    // Position-gating proof the wallet now holds only No (FR-015): Buy Yes
    // is replaced by "Close your No position first" rather than a live
    // button -- but the panel only computes a per-action plan (gating
    // included) once a quantity is entered (`TradePanel`'s `plans` memo
    // returns `{}` for an empty `qtyInput`), and a successful submit just
    // cleared that same field. Type a quantity again to make it recompute.
    await qtyInput.fill("1");
    await expect(page.getByText("Close your No position first", { exact: true })).toBeVisible();

    // The gating copy above only proves No > Yes, which a wallet holding
    // both sides could still satisfy. Assert the exact balances instead:
    // Yes == 0, No == FLOW3_QTY -- both through the app's own position
    // display (Portfolio's PositionRow) and independently via RPC token
    // balances read directly by this test.
    const market = new PublicKey(seed.openMarket.pubkey);
    const [yesMint] = yesMintPda(PROGRAM_ID, market);
    const [noMint] = noMintPda(PROGRAM_ID, market);
    const taker = new PublicKey(seed.taker.publicKey);
    const connection = new Connection(seed.rpcUrl, "confirmed");
    const yesAta = associatedTokenAddress(taker, yesMint);
    const noAta = associatedTokenAddress(taker, noMint);

    await expect
      .poll(async () => rpcTokenBalance(connection, noAta), { timeout: 20_000 })
      .toBe(FLOW3_QTY_BIGINT * BASE_UNITS_PER_CONTRACT);
    const yesBalanceBaseUnits = await rpcTokenBalance(connection, yesAta);
    expect(yesBalanceBaseUnits).toBe(0n);

    await page.goto("/portfolio");
    const heading = page.getByText(`${seed.openMarket.ticker} ${strikeLabel}`, { exact: true });
    const row = heading.locator("xpath=ancestor::div[contains(@class,'rounded')][1]");
    await expect(row.getByText(`No — qty ${FLOW3_QTY}`, { exact: true })).toBeVisible();
    await expect(row.getByText(/^Yes — qty/)).toHaveCount(0);
  });
});
