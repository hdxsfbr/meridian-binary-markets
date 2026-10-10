/**
 * Regression coverage for the account-list audit finding: `cancel_order`'s
 * builder omitted the now-required `yes_mint` account, which only surfaced
 * as a runtime "Account yesMint not provided" error against a real Anchor
 * `Program` built from the regenerated IDL -- `accountsPartial` happily
 * accepts an incomplete account map at the type level, so a TypeScript
 * compile never caught it.
 *
 * This file constructs every trade-panel/portfolio instruction in
 * `./tx.ts` through a *real* `@anchor-lang/core` `Program` seeded with the
 * regenerated `@meridian/sdk` IDL (no RPC calls -- every account here is
 * supplied explicitly, so Anchor never needs to fetch anything to resolve
 * a PDA). If a required account is missing, `.instruction()` rejects with
 * "Account <name> not provided", so this fails in CI instead of on chain.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program } from "@anchor-lang/core";
import { IDL } from "@meridian/sdk";
import { describe, expect, it } from "vitest";
import { TOKEN_2022_PROGRAM_ID } from "./ata";
import {
  buyNoLimit,
  buyNoMarket,
  cancelOrder,
  mintPair,
  placeOrder,
  redeemPair,
  sellNoMarket,
  type BuildCtx,
} from "./tx";

/** No network calls happen below: every account passed to a builder is an
 * explicit pubkey, so the real `Program`'s PDA resolver never needs to
 * fetch anything over this connection. */
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const provider = { connection, publicKey: Keypair.generate().publicKey };
const program = new Program(IDL, provider);

function buildCtx(): BuildCtx {
  return {
    program,
    user: Keypair.generate().publicKey,
    market: Keypair.generate().publicKey,
    usdcMint: Keypair.generate().publicKey,
    yesNoTokenProgram: TOKEN_2022_PROGRAM_ID,
  };
}

function makers(n: number): PublicKey[] {
  return Array.from({ length: n }, () => Keypair.generate().publicKey);
}

describe("instruction builders against the real Program + regenerated IDL", () => {
  it("cancelOrder includes yes_mint (the audited gap)", async () => {
    const ix = await cancelOrder(buildCtx(), { orderId: 1n });
    expect(ix.keys.length).toBeGreaterThan(0);
  });

  it("placeOrder builds without a missing-account rejection", async () => {
    await expect(
      placeOrder(buildCtx(), { side: 0, price: 500_000n, qty: 10n, tif: 0, makers: makers(2) }),
    ).resolves.toBeDefined();
  });

  it("cancelOrder builds without a missing-account rejection", async () => {
    await expect(cancelOrder(buildCtx(), { orderId: 1n })).resolves.toBeDefined();
  });

  it("mintPair builds without a missing-account rejection", async () => {
    await expect(mintPair(buildCtx(), { qty: 10n })).resolves.toBeDefined();
  });

  it("redeemPair builds without a missing-account rejection", async () => {
    await expect(redeemPair(buildCtx(), { qty: 10n })).resolves.toBeDefined();
  });

  it("buyNoMarket builds without a missing-account rejection", async () => {
    await expect(
      buyNoMarket(buildCtx(), { qty: 10n, minYesPrice: 400_000n, makers: makers(2) }),
    ).resolves.toBeDefined();
  });

  it("buyNoLimit builds without a missing-account rejection", async () => {
    await expect(buyNoLimit(buildCtx(), { qty: 10n, price: 400_000n })).resolves.toBeDefined();
  });

  it("sellNoMarket builds without a missing-account rejection", async () => {
    await expect(
      sellNoMarket(buildCtx(), { qty: 10n, maxYesPrice: 600_000n, makers: makers(2) }),
    ).resolves.toBeDefined();
  });
});
