#!/usr/bin/env -S node --
/**
 * `make lifecycle CLUSTER=... DEMO_SCALE=...` / `pnpm --filter @meridian/scripts run lifecycle`.
 *
 * The full create -> mint -> trade -> settle -> redeem demo (tasks.md
 * T086): creates a synthetic trading day for some or all seven tickers,
 * funds two demo users (A, the maker; B, the taker), runs the PRD §7
 * multi-user scenario on the at-the-money strike of the first ticker ("one
 * user mints and quotes, another takes, and both redeem"), waits for close,
 * publishes a closing price per ticker and settles every market created
 * this run, then has both users redeem and A cancel its untouched resting
 * order. Every step is printed as a numbered log line; the final table
 * (SOL rent, USDC flows, both users' P&L) is this script's documented
 * output (`README.md` references it).
 *
 * Flags:
 *   --close-in <seconds>   close_ts = now + this many seconds. Default 90 on
 *                          localnet; required explicitly on devnet (no
 *                          implicit default there -- a devnet demo day
 *                          closing "soon" is a deliberate choice, not a
 *                          convenience default).
 *   --tickers AAPL,META    Subset of the seven tickers, for a faster demo
 *                          run. Default: all seven (DEFAULT_TICKER_ORDER).
 *   --skip-init            Require Config to already exist; never create it
 *                          here (fails loudly instead of silently creating
 *                          one with whatever env happens to be set).
 *
 * `CLUSTER`/`DEMO_SCALE` (and everything else `lib/env.ts` parses) come from
 * the environment, same as every other script in this package.
 */

import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PREV_CLOSE_USD, DEFAULT_TICKER_ORDER } from "./lib/lifecycle/prices.js";
import { loadScriptEnv } from "./lib/env.js";
import {
  assertGenesisHash,
  createConnection,
  createTestMint,
  getMintDecimals,
  MINT_SPACE,
  TOKEN_ACCOUNT_SPACE,
} from "./lib/client.js";
import { bookSpace, computeRentTotals, lamportsToSol, marketAccountSpace } from "./rent-estimate.js";
import { resolveAdminKeypair, resolveKeypair } from "./lib/keys.js";
import { LifecycleChain, makerAccount } from "./lib/lifecycle/chain.js";
import { createSyntheticDay, deriveTickerLadders, fetchAtmMarket, totalPlannedMarkets, type SyntheticDay } from "./lib/lifecycle/day.js";
import { resolveDemoUsers, fundDemoUsers } from "./lib/lifecycle/users.js";
import { ADMIN_FEE_BUFFER_LAMPORTS, preflightSol, PUBLISHER_MIN_SOL_LAMPORTS } from "./lib/lifecycle/preflight.js";
import { publishAndSettleAll, waitUntilClose, type SettledMarketInfo } from "./lib/lifecycle/settlement.js";
import { assertEqualBigint, assertTrue } from "./lib/lifecycle/assertions.js";
import {
  EXPECTED_FINAL_PNL_MICRO_USDC,
  formatLifecycleReport,
  TRADE_1_BUY_YES,
  TRADE_2_BUY_NO,
  TRADE_3_SELL_YES,
  TRADE_4_SELL_NO,
  usdcForFill,
} from "./lib/lifecycle/trading-math.js";
import { IDL, PROGRAM_ID, configPda, decodeBook, plannedFills, type Ticker } from "@meridian/sdk";
import { buildInitializeConfigArgs } from "./init-config.js";

const ONE_USDC = 1_000_000n;
/** Each demo user's initial USDC funding (step 5). Chosen comfortably above the trading scenario's needs. */
const DEMO_USER_INITIAL_USDC = 1_000n * ONE_USDC;

let stepNumber = 0;
function logStep(line: string): void {
  stepNumber += 1;
  console.log(`[${stepNumber}] lifecycle: ${line}`);
}
function logDetail(line: string): void {
  console.log(`    ${line}`);
}

/**
 * Parses `--tickers`: validates every symbol against the fixed table (exits
 * loudly on an unknown ticker) and deduplicates the list, logging which
 * symbols were dropped (fix #11 -- `--tickers AAPL,AAPL` used to be accepted
 * as-is and caused a second `create_market` attempt against the market the
 * first occurrence already created this same run).
 */
function parseTickersFlag(argv: string[]): Ticker[] {
  const idx = argv.indexOf("--tickers");
  if (idx === -1) return [...DEFAULT_TICKER_ORDER];
  const value = argv[idx + 1];
  if (!value) throw new Error("lifecycle: --tickers requires a comma-separated list");
  const raw = value.split(",").map((s) => s.trim()) as Ticker[];
  for (const t of raw) {
    if (!(t in DEFAULT_PREV_CLOSE_USD)) {
      throw new Error(`lifecycle: --tickers contains unknown ticker "${t}"`);
    }
  }
  const seen = new Set<Ticker>();
  const deduped: Ticker[] = [];
  const duplicates: Ticker[] = [];
  for (const t of raw) {
    if (seen.has(t)) {
      duplicates.push(t);
      continue;
    }
    seen.add(t);
    deduped.push(t);
  }
  if (duplicates.length > 0) {
    console.log(
      `lifecycle: --tickers duplicates removed: ${duplicates.join(", ")} (using ${deduped.join(", ")})`,
    );
  }
  return deduped;
}

function parseCloseInFlag(argv: string[], cluster: "localnet" | "devnet"): number {
  const idx = argv.indexOf("--close-in");
  if (idx === -1) {
    if (cluster === "devnet") {
      throw new Error("lifecycle: --close-in is required explicitly on CLUSTER=devnet");
    }
    return 90;
  }
  const raw = argv[idx + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`lifecycle: --close-in must be a positive integer number of seconds, got "${raw}"`);
  }
  return value;
}

export interface RunLifecycleOptions {
  closeInSeconds?: number;
  tickers?: Ticker[];
  skipInit?: boolean;
}

export interface RunLifecycleReport {
  cluster: "localnet" | "devnet";
  programId: string;
  configAddress: string;
  tradingDay: number;
  tickers: Ticker[];
  markets: SettledMarketInfo[];
  tradedMarket: { ticker: Ticker; strike: bigint; market: string; outcome: string };
  userA: { address: string; initialUsdcMicro: bigint; finalUsdcMicro: bigint; finalYes: bigint; finalNo: bigint };
  userB: { address: string; initialUsdcMicro: bigint; finalUsdcMicro: bigint; finalYes: bigint; finalNo: bigint };
  vaultFinalMicro: bigint;
  pnlMicroUsdc: { maker: bigint; taker: bigint };
  reportText: string;
  wallClockMs: number;
}

/** Ensures `Config` exists (brief step 2): idempotent, reuses `init-config.ts`'s pure builder. */
async function ensureConfig(
  chain: LifecycleChain,
  env: ReturnType<typeof loadScriptEnv>,
  admin: ReturnType<typeof resolveAdminKeypair>,
  publisher: ReturnType<typeof resolveKeypair>,
  skipInit: boolean,
): Promise<void> {
  const existing = await chain.fetchConfig();
  if (existing) {
    logDetail(`Config already exists at ${configPda(PROGRAM_ID)[0].toBase58()}`);
    return;
  }
  if (skipInit) {
    throw new Error("lifecycle: --skip-init given but Config does not exist");
  }

  let usdcMint: PublicKey;
  if (env.usdcMint) {
    usdcMint = new PublicKey(env.usdcMint);
    const decimals = await getMintDecimals(chain.connection, usdcMint);
    if (decimals !== 6) {
      throw new Error(`lifecycle: USDC_MINT ${usdcMint.toBase58()} has ${decimals} decimals, expected 6`);
    }
  } else if (env.cluster === "localnet") {
    usdcMint = await createTestMint(chain.connection, admin, 6, admin.publicKey);
    logDetail(`created test USDC mint ${usdcMint.toBase58()} (admin is mint authority)`);
  } else {
    throw new Error("lifecycle: USDC_MINT is required on devnet (Circle devnet USDC)");
  }

  const args = buildInitializeConfigArgs({
    oracleProvider: env.oracleProvider,
    programId: PROGRAM_ID,
    pythReceiverProgram: env.pythReceiverProgram ? new PublicKey(env.pythReceiverProgram) : undefined,
    publisher: publisher.publicKey,
    demoScale: env.demoScale,
  });
  await chain.initializeConfig(args as unknown as Record<string, unknown>, usdcMint);
  logDetail(`initialize_config done (provider=${env.oracleProvider}, capacity=${args.defaultBookCapacity})`);
}

export async function runLifecycle(opts: RunLifecycleOptions = {}): Promise<RunLifecycleReport> {
  const startedAt = Date.now();
  const env = loadScriptEnv();
  const connection = createConnection(env.solanaRpcUrl);
  await assertGenesisHash(connection, env.cluster);
  logStep(`genesis check ok (cluster=${env.cluster}, rpc=${env.solanaRpcUrl})`);

  // Fix #8 (preflight step 1): resolve every key this run needs up front, before anything
  // is created or paid for.
  const admin = resolveAdminKeypair(env.adminKeypairPath, { createIfMissing: false, allowCliFallback: true });
  const publisher = resolveKeypair(env.publisherKeypairPath, { createIfMissing: env.cluster === "localnet" });
  const { userA, userB } = resolveDemoUsers(env.cluster);

  const tickers = opts.tickers ?? [...DEFAULT_TICKER_ORDER];
  const closeInSeconds = opts.closeInSeconds ?? (env.cluster === "devnet" ? (() => {
    throw new Error("lifecycle: closeInSeconds is required explicitly on devnet");
  })() : 90);

  // chain needs the USDC mint up front; resolved inside ensureConfig once Config either
  // already exists (read it back) or gets created (we already have the mint we made/verified).
  const [configAddress] = configPda(PROGRAM_ID);
  const bootstrapChain = new LifecycleChain(connection, admin, publisher, PublicKey.default);
  logStep("ensure config");
  await ensureConfig(bootstrapChain, env, admin, publisher, opts.skipInit ?? false);
  const config = await bootstrapChain.fetchConfig();
  if (!config) throw new Error("lifecycle: Config still missing after ensureConfig");

  // Fix #9: this script's settlement path (`publishAndSettleAll`) always calls
  // `mock_write_price` + relies on the mock oracle arm of `settle_market` -- trading
  // against a `Config` that isn't `MockPyth`, or whose publisher allowlist doesn't include
  // this run's publisher key, would let the whole demo trade successfully and then fail
  // unavoidably at settlement. Catch that before creating the synthetic day, not after.
  if (config.oracleProvider !== "MockPyth") {
    throw new Error(
      `lifecycle: Config.oracle_provider is "${config.oracleProvider}", but this script's settlement step always calls mock_write_price (MockPyth-only). Run \`init-config --update --provider mock\` against this cluster, then re-run lifecycle.`,
    );
  }
  if (!config.publishers.some((p) => p.equals(publisher.publicKey))) {
    throw new Error(
      `lifecycle: publisher ${publisher.publicKey.toBase58()} is not in Config.publishers (${config.publishers.map((p) => p.toBase58()).join(", ") || "<empty>"}). Run \`init-config --update --provider mock\` (with PUBLISHER_KEYPAIR_PATH set to this key) so mock_write_price/settle_market will accept it, then re-run lifecycle.`,
    );
  }

  const chain = new LifecycleChain(connection, admin, publisher, config.usdcMint);

  const capacity = config.defaultBookCapacity;

  logStep(`rent estimate (capacity=${capacity})`);
  const marketSpace = marketAccountSpace(IDL as unknown as Parameters<typeof marketAccountSpace>[0]);
  const [marketLamports, bookLamports, mintLamports, tokenAccountLamports] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(marketSpace),
    connection.getMinimumBalanceForRentExemption(bookSpace(capacity)),
    connection.getMinimumBalanceForRentExemption(MINT_SPACE),
    connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SPACE),
  ]);
  const { perMarketLamports } = computeRentTotals({
    marketLamports: BigInt(marketLamports),
    bookLamports: BigInt(bookLamports),
    mintLamports: BigInt(mintLamports),
    tokenAccountLamports: BigInt(tokenAccountLamports),
    marketsPerDay: 1,
  });
  logDetail(`per market: ~${lamportsToSol(perMarketLamports).toFixed(6)} SOL`);

  // Fix #8 (preflight step 2): check (and, on localnet, fund) every principal's balance
  // before any market is created -- admin needs enough SOL to cover this run's entire
  // planned ladder's rent plus a transaction-fee buffer; the publisher needs enough to pay
  // for `mock_write_price`; the demo users need SOL/USDC per the trading scenario
  // (`fundDemoUsers` below). On devnet, any shortfall is printed (address + exact amount)
  // and this throws rather than silently proceeding.
  const ladders = deriveTickerLadders(tickers, new Map());
  const plannedMarketCount = totalPlannedMarkets(ladders);
  const requiredAdminSolLamports = perMarketLamports * BigInt(plannedMarketCount) + ADMIN_FEE_BUFFER_LAMPORTS;
  logStep("preflight: check admin/publisher SOL balances");
  await preflightSol(
    connection,
    env.cluster,
    [
      { label: "admin", keypair: admin, requiredLamports: requiredAdminSolLamports },
      { label: "publisher", keypair: publisher, requiredLamports: PUBLISHER_MIN_SOL_LAMPORTS },
    ],
    logDetail,
  );

  logStep("preflight: check/fund demo users A (maker) and B (taker)");
  await fundDemoUsers(connection, env.cluster, chain, userA, userB, DEMO_USER_INITIAL_USDC);
  logDetail(`A: ${userA.keypair.publicKey.toBase58()}`);
  logDetail(`B: ${userB.keypair.publicKey.toBase58()}`);

  logStep(`create synthetic day for ${tickers.join(", ")} (close in ${closeInSeconds}s)`);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const day: SyntheticDay = await createSyntheticDay(
    chain,
    tickers,
    closeInSeconds,
    capacity,
    nowSeconds,
    new Map(),
    logDetail,
  );

  const firstTicker = tickers[0];
  const { marketAddress: tradedMarketAddress, market: tradedMarket0 } = await fetchAtmMarket(chain, day, firstTicker);
  let tradedMarket = tradedMarket0;

  const userAUsdcAta = await chain.usdcAta(userA.keypair.publicKey);
  const userBUsdcAta = await chain.usdcAta(userB.keypair.publicKey);
  const initialUsdcA = await chain.getTokenBalance(userAUsdcAta);
  const initialUsdcB = await chain.getTokenBalance(userBUsdcAta);

  logStep(
    `trade on ${firstTicker} ATM strike (${tradedMarket.strike}) market ${tradedMarketAddress.toBase58()}`,
  );

  // --- A mints 20 pairs ---
  await chain.mintPair(userA.keypair, tradedMarketAddress, tradedMarket, 20n);
  logDetail("A mint_pair(20): -20.00 USDC, +20 Yes, +20 No");

  // --- A quotes: asks 5@0.60, 5@0.70, bid 5@0.40 (all rest -- empty book so far) ---
  await chain.placeOrder(userA.keypair, tradedMarketAddress, tradedMarket, 1, 600_000n, 5n, 0, []);
  logDetail("A place_order(Ask, 0.60, 5, Limit): rests (order_id 1)");
  await chain.placeOrder(userA.keypair, tradedMarketAddress, tradedMarket, 1, 700_000n, 5n, 0, []);
  logDetail("A place_order(Ask, 0.70, 5, Limit): rests (order_id 2)");
  await chain.placeOrder(userA.keypair, tradedMarketAddress, tradedMarket, 0, 400_000n, 5n, 0, []);
  logDetail("A place_order(Bid, 0.40, 5, Limit): rests (order_id 3)");

  const PRICE_MAX = 999_999n;

  // Running expected balances, checked after *every* trade (not just at the end) so a
  // mismatch points straight at the step that caused it.
  let expectedA = initialUsdcA - 20n * ONE_USDC - usdcForFill(400_000n, 5n);
  let expectedB = initialUsdcB;

  // --- B: Buy Yes market (3) -- IOC bid at the price ceiling, crosses A's best ask (0.60) ---
  {
    const book = decodeBook((await connection.getAccountInfo(tradedMarket.book, "confirmed"))!.data);
    const plan = plannedFills(book, "bid", PRICE_MAX, 3n);
    assertEqualBigint(BigInt(plan.fills.length), 1n, "Buy Yes market: expected exactly one fill (against A's 0.60 ask)");
    assertEqualBigint(plan.fills[0].price, 600_000n, "Buy Yes market: fill price");
    assertEqualBigint(plan.fills[0].qty, 3n, "Buy Yes market: fill qty");
    assertTrue(plan.fills[0].maker.equals(userA.keypair.publicKey), "Buy Yes market: fill maker must be A");
    const remaining = plan.fills.map((f) => makerAccount(chain.usdcAtaAddress(f.maker)));
    await chain.placeOrder(userB.keypair, tradedMarketAddress, tradedMarket, 0, PRICE_MAX, 3n, 1, remaining);
  }
  expectedA += TRADE_1_BUY_YES.maker.usdcMicro;
  expectedB += TRADE_1_BUY_YES.taker.usdcMicro;
  assertEqualBigint(await chain.getTokenBalance(userAUsdcAta), expectedA, "A's USDC after Trade 1 (Buy Yes market)");
  assertEqualBigint(await chain.getTokenBalance(userBUsdcAta), expectedB, "B's USDC after Trade 1 (Buy Yes market)");
  logDetail(
    `B place_order(Bid, market, 3, IOC): -${(usdcForFill(600_000n, 3n) / 1000n).toString()}m USDC, +3 Yes (Trade 1)`,
  );

  // --- B: Buy No market (4) -- mints 4 pairs, IOC-sells the Yes leg into A's 0.40 bid ---
  {
    const book = decodeBook((await connection.getAccountInfo(tradedMarket.book, "confirmed"))!.data);
    const plan = plannedFills(book, "ask", 400_000n, 4n);
    assertEqualBigint(BigInt(plan.fills.length), 1n, "Buy No market: expected exactly one fill (against A's 0.40 bid)");
    assertEqualBigint(plan.fills[0].price, 400_000n, "Buy No market: fill price");
    assertEqualBigint(plan.fills[0].qty, 4n, "Buy No market: fill qty");
    assertTrue(plan.fills[0].maker.equals(userA.keypair.publicKey), "Buy No market: fill maker must be A");
    const remaining = plan.fills.map((f) => makerAccount(chain.yesAtaAddress(f.maker, tradedMarket.yesMint)));
    await chain.buyNoMarket(userB.keypair, tradedMarketAddress, tradedMarket, 4n, 400_000n, remaining);
  }
  expectedA += TRADE_2_BUY_NO.maker.usdcMicro;
  expectedB += TRADE_2_BUY_NO.taker.usdcMicro;
  assertEqualBigint(await chain.getTokenBalance(userAUsdcAta), expectedA, "A's USDC after Trade 2 (Buy No market)");
  assertEqualBigint(await chain.getTokenBalance(userBUsdcAta), expectedB, "B's USDC after Trade 2 (Buy No market)");
  logDetail("B buy_no_market(4, min_yes_price=0.40): Trade 2 (-2.40 USDC net, +4 No)");

  // --- B: Sell Yes market (1) -- IOC ask at the price floor, crosses A's last 0.40 bid unit ---
  {
    const book = decodeBook((await connection.getAccountInfo(tradedMarket.book, "confirmed"))!.data);
    const plan = plannedFills(book, "ask", 1n, 1n);
    assertEqualBigint(BigInt(plan.fills.length), 1n, "Sell Yes market: expected exactly one fill (against A's last 0.40 bid unit)");
    assertEqualBigint(plan.fills[0].qty, 1n, "Sell Yes market: fill qty");
    assertTrue(plan.fills[0].maker.equals(userA.keypair.publicKey), "Sell Yes market: fill maker must be A");
    const remaining = plan.fills.map((f) => makerAccount(chain.yesAtaAddress(f.maker, tradedMarket.yesMint)));
    await chain.placeOrder(userB.keypair, tradedMarketAddress, tradedMarket, 1, 1n, 1n, 1, remaining);
  }
  expectedA += TRADE_3_SELL_YES.maker.usdcMicro;
  expectedB += TRADE_3_SELL_YES.taker.usdcMicro;
  assertEqualBigint(await chain.getTokenBalance(userAUsdcAta), expectedA, "A's USDC after Trade 3 (Sell Yes market)");
  assertEqualBigint(await chain.getTokenBalance(userBUsdcAta), expectedB, "B's USDC after Trade 3 (Sell Yes market)");
  logDetail("B place_order(Ask, market, 1, IOC): Trade 3 (+0.40 USDC, -1 Yes)");

  // --- B: Sell No market (2) -- IOC-buys 2 Yes from A's remaining 0.60 ask, redeems the pair ---
  {
    const book = decodeBook((await connection.getAccountInfo(tradedMarket.book, "confirmed"))!.data);
    const plan = plannedFills(book, "bid", 600_000n, 2n);
    assertEqualBigint(BigInt(plan.fills.length), 1n, "Sell No market: expected exactly one fill (against A's remaining 0.60 ask)");
    assertEqualBigint(plan.fills[0].qty, 2n, "Sell No market: fill qty");
    assertTrue(plan.fills[0].maker.equals(userA.keypair.publicKey), "Sell No market: fill maker must be A");
    const remaining = plan.fills.map((f) => makerAccount(chain.usdcAtaAddress(f.maker)));
    await chain.sellNoMarket(userB.keypair, tradedMarketAddress, tradedMarket, 2n, 600_000n, remaining);
  }
  expectedA += TRADE_4_SELL_NO.maker.usdcMicro;
  expectedB += TRADE_4_SELL_NO.taker.usdcMicro;
  assertEqualBigint(await chain.getTokenBalance(userAUsdcAta), expectedA, "A's USDC after Trade 4 (Sell No market)");
  assertEqualBigint(await chain.getTokenBalance(userBUsdcAta), expectedB, "B's USDC after Trade 4 (Sell No market)");
  logDetail("B sell_no_market(2, max_yes_price=0.60): Trade 4 (+0.80 USDC net, -2 No)");
  logDetail("trading deltas match hand-computed expectations (trading-math.ts), checked after every trade");

  // --- A cancels its untouched resting order (the 0.70 ask, order_id 2) ---
  logStep("A cancels remaining resting order");
  {
    const book = decodeBook((await connection.getAccountInfo(tradedMarket.book, "confirmed"))!.data);
    const stillResting = book.asks.find((o) => o.price === 700_000n);
    assertTrue(stillResting !== undefined, "A's 0.70 ask must still be resting before cancellation");
    await chain.cancelOrder(userA.keypair, tradedMarketAddress, tradedMarket, stillResting!.id);
    logDetail(`cancel_order(${stillResting!.id}): refunds 5 Yes to A`);
  }

  // --- Wait for close, publish, settle every market created this run ---
  logStep("wait for close");
  await waitUntilClose(connection, day.closeTs, logDetail);

  logStep("publish closing prices and settle every market");
  const markets = await publishAndSettleAll(chain, day, logDetail);

  tradedMarket = (await chain.fetchMarket(tradedMarketAddress))!;
  assertTrue(tradedMarket.state === "Settled", "traded market must be Settled");
  assertTrue(tradedMarket.outcome === "Yes", "traded market must resolve Yes (settlement price = strike + $5)");
  logDetail(`traded market settled: outcome=${tradedMarket.outcome}, settlement_price=${tradedMarket.settlementPrice}`);

  // --- Both users redeem their winning (Yes) holdings; A's leftover No (and B's) stay worthless ---
  // `getTokenBalance` returns raw base units (6 decimals); every instruction's `qty`
  // argument (including `redeem_winning`'s) is in *whole* Yes/No/pair units (same
  // convention as `mint_pair`/`place_order` above), so the raw balance must be divided
  // by `ONE_USDC` (one whole unit's base-unit count -- Yes/No mints share USDC's 6
  // decimals, per `mint_pair.rs`) before being passed as `qty`.
  logStep("A and B redeem winnings");
  const finalYesABase = await chain.getTokenBalance(chain.yesAtaAddress(userA.keypair.publicKey, tradedMarket.yesMint));
  const finalYesBBase = await chain.getTokenBalance(chain.yesAtaAddress(userB.keypair.publicKey, tradedMarket.yesMint));
  assertEqualBigint(finalYesABase % ONE_USDC, 0n, "A's Yes balance must be a whole number of tokens");
  assertEqualBigint(finalYesBBase % ONE_USDC, 0n, "B's Yes balance must be a whole number of tokens");
  const finalYesA = finalYesABase / ONE_USDC;
  const finalYesB = finalYesBBase / ONE_USDC;
  assertEqualBigint(finalYesA, 20n, "A's whole Yes balance before redeem_winning");
  assertEqualBigint(finalYesB, 2n, "B's whole Yes balance before redeem_winning");
  if (finalYesA > 0n) {
    await chain.redeemWinning(userA.keypair, tradedMarketAddress, tradedMarket, 1, finalYesA);
    logDetail(`A redeem_winning(Yes, ${finalYesA}): +${finalYesA} USDC`);
  }
  if (finalYesB > 0n) {
    await chain.redeemWinning(userB.keypair, tradedMarketAddress, tradedMarket, 1, finalYesB);
    logDetail(`B redeem_winning(Yes, ${finalYesB}): +${finalYesB} USDC`);
  }

  const finalUsdcA = await chain.getTokenBalance(userAUsdcAta);
  const finalUsdcB = await chain.getTokenBalance(userBUsdcAta);
  const finalNoA = await chain.getTokenBalance(chain.noAtaAddress(userA.keypair.publicKey, tradedMarket.noMint));
  const finalNoB = await chain.getTokenBalance(chain.noAtaAddress(userB.keypair.publicKey, tradedMarket.noMint));
  const vaultFinal = await chain.getTokenBalance(tradedMarket.vault);

  const pnlA = finalUsdcA - initialUsdcA;
  const pnlB = finalUsdcB - initialUsdcB;
  assertEqualBigint(pnlA, EXPECTED_FINAL_PNL_MICRO_USDC.maker, "A's final P&L");
  assertEqualBigint(pnlB, EXPECTED_FINAL_PNL_MICRO_USDC.taker, "B's final P&L");
  assertEqualBigint(vaultFinal, 0n, "traded market vault must be 0 after all winners redeem");
  logDetail("final P&L and vault-zero assertions passed");

  const reportText = formatLifecycleReport({
    cluster: env.cluster,
    programId: PROGRAM_ID.toBase58(),
    configAddress: configAddress.toBase58(),
    tradingDay: day.tradingDay,
    tickers,
    markets: markets.map((m) => ({
      ticker: m.ticker,
      strike: m.strike,
      market: m.market.toBase58(),
      state: m.state,
      outcome: m.outcome,
    })),
    rentSolPerMarket: lamportsToSol(perMarketLamports),
    rentSolTotal: lamportsToSol(perMarketLamports * BigInt(markets.length)),
    userA: { address: userA.keypair.publicKey.toBase58(), initialUsdcMicro: initialUsdcA, finalUsdcMicro: finalUsdcA },
    userB: { address: userB.keypair.publicKey.toBase58(), initialUsdcMicro: initialUsdcB, finalUsdcMicro: finalUsdcB },
    vaultFinalMicro: vaultFinal,
    wallClockMs: Date.now() - startedAt,
  });
  console.log(reportText);

  return {
    cluster: env.cluster,
    programId: PROGRAM_ID.toBase58(),
    configAddress: configAddress.toBase58(),
    tradingDay: day.tradingDay,
    tickers,
    markets,
    tradedMarket: {
      ticker: firstTicker,
      strike: tradedMarket.strike,
      market: tradedMarketAddress.toBase58(),
      outcome: tradedMarket.outcome,
    },
    userA: { address: userA.keypair.publicKey.toBase58(), initialUsdcMicro: initialUsdcA, finalUsdcMicro: finalUsdcA, finalYes: 0n, finalNo: finalNoA },
    userB: { address: userB.keypair.publicKey.toBase58(), initialUsdcMicro: initialUsdcB, finalUsdcMicro: finalUsdcB, finalYes: 0n, finalNo: finalNoB },
    vaultFinalMicro: vaultFinal,
    pnlMicroUsdc: { maker: pnlA, taker: pnlB },
    reportText,
    wallClockMs: Date.now() - startedAt,
  };
}

async function main(): Promise<void> {
  const argv = process.argv;
  const env = loadScriptEnv();
  const closeInSeconds = parseCloseInFlag(argv, env.cluster);
  const tickers = parseTickersFlag(argv);
  const skipInit = argv.includes("--skip-init");
  await runLifecycle({ closeInSeconds, tickers, skipInit });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
