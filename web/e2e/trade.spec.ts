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
import { PROGRAM_ID, TOKEN_2022_PROGRAM_ID, noMintPda, yesMintPda } from "@meridian/sdk";
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
  test("order book renders correctly from both the Yes and the No perspective", async ({ page }) => {
    test.setTimeout(60_000);
    const seed = loadSeed();
    const strikeLabel = formatStrike(BigInt(seed.openMarket.strike));

    await connectAs(page, seed.taker.secretKeyBase58);
    await page.goto(`/trade/${seed.openMarket.ticker}`);
    await clickConnect(page);
    await page.locator("tr", { hasText: strikeLabel }).first().click();

    // The order book table (the second `<table>` on the page -- the first
    // is the strike list; see trade.spec.ts's other flows for the same
    // `.last()` convention). This test never sends a transaction (read-only:
    // it only clicks the Yes/No perspective toggle, never a trade action),
    // and `seed.ts`'s dedicated `pnlMarket` keeps `portfolio.spec.ts`'s own
    // mint/sell test off of this market entirely -- so the book here is
    // always exactly what `seed.ts` seeded: Ask $0.60 x 5 (`MAKER_ASK_QTY`),
    // Bid $0.40 x 4 (`MAKER_BID_QTY`), regardless of which spec file runs
    // first.
    const bookTable = page.locator("table").last();
    const row = bookTable.locator("tbody tr").first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // --- Yes perspective (default on load): best bid $0.40 x 4, best ask $0.60 x 5 ---
    await expect(page.getByText("Best bid $0.40", { exact: false })).toBeVisible();
    await expect(page.getByText("Best ask $0.60", { exact: false })).toBeVisible();
    const cells = row.locator("td");
    await expect(cells.nth(0)).toHaveText("4"); // bid size
    await expect(cells.nth(1)).toHaveText("$0.40"); // bid price
    await expect(cells.nth(3)).toHaveText("$0.60"); // ask price
    await expect(cells.nth(4)).toHaveText("5"); // ask size

    // --- Toggle to the No perspective: every price becomes $1.00 minus its Yes
    // price, and each level's size stays attached to the same underlying
    // order -- the Yes ask (price $0.60, size 5) becomes the No bid (price
    // $0.40, size 5); the Yes bid (price $0.40, size 4) becomes the No ask
    // (price $0.60, size 4). ---
    await page.getByRole("button", { name: "No", exact: true }).click();
    await expect(page.getByRole("button", { name: "No", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Best bid $0.40", { exact: false })).toBeVisible();
    await expect(page.getByText("Best ask $0.60", { exact: false })).toBeVisible();
    await expect(cells.nth(0)).toHaveText("5"); // No bid size == Yes ask size
    await expect(cells.nth(1)).toHaveText("$0.40"); // No bid price == $1.00 - Yes ask price ($1.00 - $0.60)
    await expect(cells.nth(3)).toHaveText("$0.60"); // No ask price == $1.00 - Yes bid price ($1.00 - $0.40)
    await expect(cells.nth(4)).toHaveText("4"); // No ask size == Yes bid size

    // --- Toggle back to Yes: the original view is restored exactly. ---
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Yes", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(cells.nth(0)).toHaveText("4");
    await expect(cells.nth(1)).toHaveText("$0.40");
    await expect(cells.nth(3)).toHaveText("$0.60");
    await expect(cells.nth(4)).toHaveText("5");
  });

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

    // Confirmation toast (Andre's complaint: nothing confirms a successful
    // order). The market Buy No above fills, so the toast reports it as
    // bought, not a raw transaction detail.
    await expect(page.getByRole("status").filter({ hasText: "Bought" })).toBeVisible({ timeout: 20_000 });

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
    // Every market `createMarket` creates uses Token-2022 Yes/No mints (see
    // `chain.ts`'s doc comment on `createMarket`) -- `associatedTokenAddress`
    // defaults to classic SPL Token when its third argument is omitted, which
    // derives a *different* (and in this case never-created) account, so the
    // token program must be passed explicitly here.
    const yesAta = associatedTokenAddress(taker, yesMint, TOKEN_2022_PROGRAM_ID);
    const noAta = associatedTokenAddress(taker, noMint, TOKEN_2022_PROGRAM_ID);

    await expect
      .poll(async () => rpcTokenBalance(connection, noAta), { timeout: 20_000 })
      .toBe(FLOW3_QTY_BIGINT * BASE_UNITS_PER_CONTRACT);
    const yesBalanceBaseUnits = await rpcTokenBalance(connection, yesAta);
    expect(yesBalanceBaseUnits).toBe(0n);

    await page.goto("/portfolio");
    // Scoped to the "Positions" section specifically -- `PositionRow`'s own
    // heading always renders a trailing "· <trading day>" span alongside the
    // ticker/strike text (so an `exact: true` match against just the
    // ticker/strike never matches anything), and "Your quotes"' own summary
    // table repeats the same ticker/strike text in a visible `<td>`
    // elsewhere on the page, which an unscoped substring search would
    // ambiguously match too.
    const positionsSection = page.locator("section", { hasText: "Positions" });
    const heading = positionsSection.getByText(`${seed.openMarket.ticker} ${strikeLabel}`);
    const row = heading.locator("xpath=ancestor::div[contains(@class,'rounded')][1]");
    await expect(row.getByText(`No — qty ${FLOW3_QTY}`, { exact: true })).toBeVisible();
    await expect(row.getByText(/^Yes — qty/)).toHaveCount(0);
  });
});
