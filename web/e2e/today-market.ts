#!/usr/bin/env -S node --
/**
 * Creates TODAY's open markets so `make dev`'s browser Markets/Trade pages
 * have contracts to show (Wave 7/8 review item 7). `scripts/lifecycle.ts`'s
 * demo deliberately creates markets dated *tomorrow*
 * (`scripts/lib/lifecycle/day.ts`'s `syntheticTradingDay`) so it never
 * collides with a real trading session -- which leaves the browser's own
 * "today" views (`useMarkets`'s `trading_day` filter, via
 * `@/lib/markets`'s `todayTradingDay`) with nothing to display right after
 * `make dev` finishes.
 *
 * Reuses `seed.ts`'s `createTodaysMarkets`/`fetchAtmMarket` (the same
 * building blocks `scripts/lifecycle.ts` uses) to create one ticker's
 * strike ladder dated today, with a disposable maker resting a bid and an
 * ask on the ATM strike and a close six hours out -- long enough to outlive
 * a `make dev` session. Run standalone: `pnpm --filter @meridian/web exec
 * tsx e2e/today-market.ts`.
 */

import { fileURLToPath } from "node:url";
import { LAMPORTS_PER_SOL, Keypair, PublicKey } from "@solana/web3.js";
import type { Ticker } from "@meridian/sdk";
import { loadScriptEnv } from "../../scripts/lib/env.js";
import { assertGenesisHash, createConnection } from "../../scripts/lib/client.js";
import { resolveAdminKeypair, resolveKeypair } from "../../scripts/lib/keys.js";
import { LifecycleChain } from "../../scripts/lib/lifecycle/chain.js";
import { getOnChainUnixTimestamp } from "../../scripts/lib/lifecycle/settlement.js";
import { createTodaysMarkets, fetchAtmMarket } from "./seed.js";

const TICKER: Ticker = "AAPL";
const CLOSE_IN_SECONDS = 6 * 60 * 60; // 6 hours: outlives a `make dev` session.
const ONE_USDC = 1_000_000n;
const MAKER_SOL = 2 * LAMPORTS_PER_SOL;
const MAKER_USDC = 1_000n * ONE_USDC;

const MAKER_MINT_QTY = 20n;
const MAKER_ASK_PRICE = 600_000n; // $0.60
const MAKER_ASK_QTY = 5n;
const MAKER_BID_PRICE = 400_000n; // $0.40
const MAKER_BID_QTY = 5n;

function log(line: string): void {
  console.log(`[today-market] ${line}`);
}

export async function createTodaysOpenMarket(): Promise<void> {
  const env = loadScriptEnv();
  if (env.cluster !== "localnet") {
    throw new Error(`today-market: CLUSTER must be "localnet", got "${env.cluster}"`);
  }
  const connection = createConnection(env.solanaRpcUrl);
  await assertGenesisHash(connection, env.cluster);

  const admin = resolveAdminKeypair(env.adminKeypairPath, { createIfMissing: false, allowCliFallback: true });
  const publisher = resolveKeypair(env.publisherKeypairPath, { createIfMissing: true });

  const bootstrapChain = new LifecycleChain(connection, admin, publisher, PublicKey.default);
  const config = await bootstrapChain.fetchConfig();
  if (!config) {
    throw new Error("today-market: Config does not exist -- run `init-config` against this validator first");
  }
  const chain = new LifecycleChain(connection, admin, publisher, config.usdcMint);
  const capacity = config.defaultBookCapacity;

  // A disposable maker (never persisted to `keys/`), funded fresh here --
  // this is a one-shot setup script, not a shared fixture other `make`
  // targets read back.
  const maker = Keypair.generate();
  const sig = await connection.requestAirdrop(maker.publicKey, MAKER_SOL);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  const makerUsdcAta = await chain.usdcAta(maker.publicKey);
  await chain.fundUsdc(makerUsdcAta, MAKER_USDC);
  log(`funded disposable maker ${maker.publicKey.toBase58()}`);

  const now = await getOnChainUnixTimestamp(connection);
  const day = await createTodaysMarkets(chain, [TICKER], CLOSE_IN_SECONDS, capacity, now);
  const { marketAddress, market } = await fetchAtmMarket(chain, day, TICKER);

  await chain.mintPair(maker, marketAddress, market, MAKER_MINT_QTY);
  log(`maker mint_pair(${MAKER_MINT_QTY}) on ${TICKER} ${marketAddress.toBase58()}`);
  await chain.placeOrder(maker, marketAddress, market, 1, MAKER_ASK_PRICE, MAKER_ASK_QTY, 0, []);
  log(`maker rests Ask ${MAKER_ASK_PRICE} x ${MAKER_ASK_QTY}`);
  await chain.placeOrder(maker, marketAddress, market, 0, MAKER_BID_PRICE, MAKER_BID_QTY, 0, []);
  log(`maker rests Bid ${MAKER_BID_PRICE} x ${MAKER_BID_QTY}`);

  console.log("Open markets for today created");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  createTodaysOpenMarket().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
