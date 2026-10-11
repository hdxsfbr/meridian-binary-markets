/**
 * Playwright smoke flow 5 (contracts/frontend.md, tasks.md T075): paused ->
 * trade disabled, redeem enabled. Drives the browser as the real
 * `Config.admin` keypair (the only identity `/admin` accepts), since pausing
 * requires the admin-only `pause`/`unpause` instructions. Always unpauses
 * again before the test ends, regardless of pass/fail, so later spec files
 * (which trade on the open market) aren't left stuck against a paused
 * `Config` -- `test.describe.configure({ mode: "serial" })` plus
 * `afterAll` would work too, but an inline `try/finally` around the one
 * assertion that needs the paused state keeps the "always unpause" promise
 * local to this one test instead of relying on hook ordering.
 */

import { test, expect } from "@playwright/test";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, TOKEN_2022_PROGRAM_ID, noMintPda, yesMintPda } from "@meridian/sdk";
import { associatedTokenAddress } from "../src/lib/ata";
import { formatStrike } from "../src/lib/format";
import { clickConnect, connectAs, loadSeed } from "./fixtures";

const ACTION_LABELS = ["Buy Yes", "Buy No", "Sell Yes", "Sell No"] as const;

/** Reads a token account's raw base-unit balance via RPC; an absent/empty ATA reads as 0n. */
async function rpcTokenBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const result = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(result.value.amount);
  } catch {
    return 0n;
  }
}

test("flow 5: paused disables trading but leaves redeem enabled", async ({ page }) => {
  test.setTimeout(90_000);
  const seed = loadSeed();

  await connectAs(page, seed.admin.secretKeyBase58);
  await page.goto("/admin");
  await clickConnect(page);

  await expect(page.getByRole("heading", { name: "Config" })).toBeVisible();
  const pauseButton = page.getByRole("button", { name: "Pause", exact: true });
  const unpauseButton = page.getByRole("button", { name: "Unpause", exact: true });

  const pausedValue = page.locator("dt", { hasText: "Paused" }).locator("xpath=following-sibling::dd[1]");

  try {
    await pauseButton.click();
    await expect(pausedValue).toHaveText("Yes", { timeout: 20_000 });
    await expect(unpauseButton).toBeEnabled();

    // Trade disabled: the trade panel on the (still open) seeded market shows
    // "Trading is paused" instead of live action buttons, and every trade
    // action (Buy Yes/Buy No/Sell Yes/Sell No) is disabled or absent --
    // not just the paused message visible.
    const strikeLabel = formatStrike(BigInt(seed.openMarket.strike));
    await page.goto(`/trade/${seed.openMarket.ticker}`);
    await page.locator("tr", { hasText: strikeLabel }).first().click();
    await expect(page.getByText("Trading is paused", { exact: true })).toBeVisible({ timeout: 20_000 });
    for (const label of ACTION_LABELS) {
      const actionButton = page.getByRole("button", { name: label, exact: true });
      const count = await actionButton.count();
      if (count > 0) {
        await expect(actionButton).toBeDisabled();
      }
    }

    // Portfolio's Mint control is disabled too (FR-034): the market-maker
    // panel's submit button swaps to "Trading is paused" and is disabled.
    // Scoped to the "Pairs to mint" form specifically -- the quote form's
    // own "Add to queue" button shows the exact same "Trading is paused"
    // label while disabled, so an unscoped lookup is ambiguous.
    await page.goto("/portfolio");
    const mintForm = page.locator("form").filter({ hasText: "Pairs to mint" });
    const mintButton = mintForm.getByRole("button", { name: "Trading is paused", exact: true });
    await expect(mintButton).toBeVisible({ timeout: 20_000 });
    await expect(mintButton).toBeDisabled();

    // Redeem enabled: the admin's own minted pair on the settled market can still
    // be redeemed for its winning side while the market is paused (FR-034).
    const redeemButton = page.getByRole("button", { name: "Redeem winning", exact: true });
    await expect(redeemButton).toBeVisible({ timeout: 20_000 });
    await expect(redeemButton).toBeEnabled();

    const market = new PublicKey(seed.settledMarket.pubkey);
    const [yesMint] = yesMintPda(PROGRAM_ID, market);
    const [noMint] = noMintPda(PROGRAM_ID, market);
    const winningMint = seed.settledMarket.outcome === "yes" ? yesMint : noMint;
    const admin = new PublicKey(seed.admin.publicKey);
    const connection = new Connection(seed.rpcUrl, "confirmed");
    // Every market `createMarket` creates uses Token-2022 Yes/No mints --
    // `associatedTokenAddress` defaults to classic SPL Token when its third
    // argument is omitted, which derives a different (never-created)
    // account, so the token program must be passed explicitly here.
    const winningAta = associatedTokenAddress(admin, winningMint, TOKEN_2022_PROGRAM_ID);
    const minted = BigInt(seed.admin.settledPairsMinted);

    const balanceBeforeRedeem = await rpcTokenBalance(connection, winningAta);
    expect(balanceBeforeRedeem).toBe(minted * 1_000_000n);

    const usdcBalance = page.getByTestId("usdc-balance");
    await expect(usdcBalance).toHaveText(/^\$-?[\d,]+\.\d{2}$/, { timeout: 20_000 });
    const usdcBefore = Number((await usdcBalance.innerText()).replace(/[$,]/g, ""));

    await redeemButton.click();

    // Confirmed token removal via RPC -- not the "Redeeming…" label swap,
    // which happens immediately on click and proves nothing about whether
    // the transaction actually landed -- plus the exact payout, while
    // Config remains paused throughout.
    await expect
      .poll(async () => rpcTokenBalance(connection, winningAta), { timeout: 30_000 })
      .toBe(0n);

    // Config must still be paused at the moment of (and immediately after)
    // redemption -- this is what "redeem works even while paused" actually
    // means, as opposed to redeeming after some unrelated unpause. Checked
    // on `/admin` (a fresh navigation, independent of the `/portfolio`
    // locators above) rather than mid-flow on the portfolio page, which has
    // no "Paused" `dt`/`dd` pair of its own.
    await page.goto("/admin");
    await expect(pausedValue).toHaveText("Yes");
    await page.goto("/portfolio");
    await expect
      .poll(async () => Number((await usdcBalance.innerText()).replace(/[$,]/g, "")), { timeout: 40_000 })
      .toBeCloseTo(usdcBefore + Number(minted), 6);
  } finally {
    await page.goto("/admin");
    await unpauseButton.click();
    await expect(pausedValue).toHaveText("No", { timeout: 20_000 });
  }
});
