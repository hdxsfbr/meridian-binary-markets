#!/usr/bin/env -S node --
/**
 * Chain fixture for the Wave 7 Playwright smoke suite (tasks.md
 * T066/T075/T080). Run once per `make test-web` invocation, against the
 * fresh local validator that same target already deployed the program and
 * initialized `Config` on (reuses `scripts/lib/lifecycle/*` directly --
 * the same building blocks `scripts/lifecycle.ts` uses -- rather than
 * `runLifecycle` itself, which runs a fixed seven-ticker demo; this only
 * needs two small markets):
 *
 *   - an OPEN market (closes ~30 minutes out, long enough to outlive the
 *     whole suite) with a maker (a script-only keypair, never loaded into
 *     the browser) resting both a Yes ASK and a Yes BID, so `trade.spec.ts`
 *     can exercise a limit Buy Yes that simply rests (flow 2) and a Buy No
 *     market that crosses the resting BID (flow 3 -- `buy_no_market` mints
 *     a pair and IOC-sells the Yes leg into bids, per
 *     `scripts/lib/lifecycle/chain.ts`'s doc comment on `buyNoMarket`);
 *   - a SETTLED market (closes ~20s out, waited out and settled with
 *     `publishAndSettleAll` before this script exits) that the taker
 *     already holds a minted pair on, so `portfolio.spec.ts` can redeem a
 *     winning position (flow 4) without needing any trading step first.
 *
 * Every pubkey/keypair a spec needs is written to `SEED_PATH`
 * (`/tmp/meridian-e2e-seed.json`); `global-setup.ts` calls `runSeed()`
 * directly (an import, not a subprocess -- this file is already
 * TypeScript-to-TypeScript) and the specs read the JSON back.
 *
 * Also runnable standalone (`tsx web/e2e/seed.ts`, same convention as every
 * other script's `isMain` guard) for manual debugging against a validator
 * someone already has `deploy`/`init-config` run against.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, type Ticker } from "@meridian/sdk";
import { loadScriptEnv } from "../../scripts/lib/env.js";
import { assertGenesisHash, createConnection } from "../../scripts/lib/client.js";
import { resolveAdminKeypair, resolveKeypair } from "../../scripts/lib/keys.js";
import { LifecycleChain, type MarketAccountDecoded } from "../../scripts/lib/lifecycle/chain.js";
import { deriveTickerLadders, type SyntheticDay, type TickerDay } from "../../scripts/lib/lifecycle/day.js";
import { fundDemoUsers, type DemoUser } from "../../scripts/lib/lifecycle/users.js";
import { getOnChainUnixTimestamp, publishAndSettleAll, waitUntilClose } from "../../scripts/lib/lifecycle/settlement.js";
// Same function the frontend's Markets/Trade pages call (`useMarkets`'s
// `trading_day` filter) -- not `scripts/lib/lifecycle/day.ts`'s
// `syntheticTradingDay`, which is deliberately *tomorrow's* date so the
// demo lifecycle script never collides with a real trading session. This
// suite needs the opposite: markets dated *today*, so the browser's own
// "today" views (which call this exact function) find them.
import { todayTradingDay } from "../src/lib/markets";

// A private temp dir, mode 0700 -- not Node's default `/tmp` permissions --
// since the fixture file holds disposable-but-real signing keys (see
// `runSeed` below). Deliberately a *fixed* name rather than
// `mkdtempSync`'s random one: `globalSetup` (which calls `runSeed`) and
// each spec file (via `fixtures.ts`'s `loadSeed`) import this module from
// separate Node processes -- Playwright's `globalSetup` is never the same
// process as a test worker -- so a per-process-random directory name would
// leave every worker looking for a seed file in a directory `globalSetup`
// never wrote to (exactly the ENOENT this fixed name avoids). Keyed by uid
// to avoid collisions with other users on a shared `/tmp`.
// `web/e2e/global-teardown.ts` removes this whole directory after the
// suite finishes.
const SEED_DIR = join(tmpdir(), `meridian-e2e-${process.getuid?.() ?? "shared"}`);
mkdirSync(SEED_DIR, { recursive: true });
chmodSync(SEED_DIR, 0o700);
export const SEED_PATH = join(SEED_DIR, "seed.json");

const OPEN_TICKER: Ticker = "AAPL";
const SETTLED_TICKER: Ticker = "META";
const OPEN_CLOSE_IN_SECONDS = 1800; // ~30 minutes: outlives the whole suite.
// Short (this script waits it out and settles before exiting), but with
// enough headroom (>= 45s) to cover creating the settled market's strike
// ladder plus minting both the taker's and admin's pairs on slower
// machines -- all of that work happens between this constant being read
// (at market creation, when `close_ts` is baked into the account) and
// `waitUntilClose` being called, which is only reached once every position
// above is already minted (see the call sites below).
const SETTLED_CLOSE_IN_SECONDS = 45;

const ONE_USDC = 1_000_000n;
const DEMO_USER_INITIAL_USDC = 1_000n * ONE_USDC;

const MAKER_MINT_QTY = 20n;
const MAKER_ASK_PRICE = 600_000n; // $0.60
const MAKER_ASK_QTY = 5n;
const MAKER_BID_PRICE = 400_000n; // $0.40
const MAKER_BID_QTY = 5n;

/** Minted directly on the settled market so the taker has something to redeem once it settles (flow 4). */
const TAKER_SETTLED_MINT_QTY = 10n;
/** Minted directly on the settled market so the admin has something to redeem while paused (flow 5). */
const ADMIN_SETTLED_MINT_QTY = 4n;

export interface SeedMarket {
  ticker: Ticker;
  strike: string;
  pubkey: string;
  closeTs: number;
}

export interface SeedSettledMarket extends SeedMarket {
  outcome: "yes" | "no";
  settlementPrice: string;
}

export interface SeedIdentity {
  publicKey: string;
  secretKeyBase58: string;
}

export interface SeedResult {
  programId: string;
  rpcUrl: string;
  openMarket: SeedMarket;
  settledMarket: SeedSettledMarket;
  /** Config.admin -- the only identity `/admin` accepts (admin.spec.ts). Also holds a minted pair on the settled market. */
  admin: SeedIdentity & { settledPairsMinted: string };
  /** Resting-liquidity provider for the open market. Never loaded into the browser. */
  maker: SeedIdentity;
  /** Funded demo user used as the browser wallet in trade.spec.ts/portfolio.spec.ts. */
  taker: SeedIdentity & { settledPairsMinted: string };
}

function log(line: string): void {
  console.log(`[seed] ${line}`);
}

/**
 * Creates every strike's `Market` + `Book` for `tickers`, dated
 * `todayTradingDay()` (today's real trading day, not
 * `scripts/lib/lifecycle/day.ts`'s synthetic "tomorrow") -- the browser's
 * own Markets/Trade pages filter `getProgramAccounts` by that exact value,
 * so this is what makes the seeded markets show up there at all. Mirrors
 * `createSyntheticDay`'s core loop minus its fresh-day search: a validator
 * `make test-web` just reset can never already have a market at today's
 * trading day, so there is nothing to search around.
 */
export async function createTodaysMarkets(
  chain: LifecycleChain,
  tickers: Ticker[],
  closeInSeconds: number,
  capacity: number,
  nowSeconds: number,
): Promise<SyntheticDay> {
  const tradingDay = todayTradingDay(nowSeconds * 1000);
  const closeTs = nowSeconds + closeInSeconds;
  const ladders = deriveTickerLadders(tickers, new Map());

  const byTicker = new Map<Ticker, TickerDay>();
  for (const ticker of tickers) {
    const { prevCloseMicro, ladder, atmStrike } = ladders.get(ticker)!;
    const strikesToMarkets = new Map<string, PublicKey>();
    for (const strike of ladder) {
      const market = await chain.createMarket(ticker, strike, tradingDay, closeTs, capacity);
      log(`create_market ${ticker} strike=${strike} -> ${market.toBase58()}`);
      await chain.createBookUntilDone(market);
      log(`create_book   ${ticker} strike=${strike} -> market ${market.toBase58()} book ready`);
      strikesToMarkets.set(strike.toString(), market);
    }
    byTicker.set(ticker, { ticker, prevCloseMicro, ladder, atmStrike, strikesToMarkets });
  }

  return { tradingDay, closeTs, capacity, byTicker };
}

/** `fetchAtmMarket`'s logic, inlined so this file depends on one fewer `scripts/lib` export. */
export async function fetchAtmMarket(
  chain: LifecycleChain,
  day: SyntheticDay,
  ticker: Ticker,
): Promise<{ marketAddress: PublicKey; market: MarketAccountDecoded }> {
  const tickerDay = day.byTicker.get(ticker);
  if (!tickerDay) throw new Error(`fetchAtmMarket: no day data for ${ticker}`);
  const marketAddress = tickerDay.strikesToMarkets.get(tickerDay.atmStrike.toString());
  if (!marketAddress) throw new Error(`fetchAtmMarket: no market for ${ticker} ATM strike ${tickerDay.atmStrike}`);
  const market = await chain.fetchMarket(marketAddress);
  if (!market) throw new Error(`fetchAtmMarket: market ${marketAddress.toBase58()} does not exist on chain`);
  return { marketAddress, market };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 encoder (Bitcoin alphabet); `web/src/lib/e2e-wallet.ts` carries the matching decoder. */
function encodeBase58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros += 1;
  }
  return BASE58_ALPHABET[0].repeat(leadingZeros) + digits.reverse().map((d) => BASE58_ALPHABET[d]).join("");
}

function identityOf(keypair: { publicKey: { toBase58(): string }; secretKey: Uint8Array }): SeedIdentity {
  return { publicKey: keypair.publicKey.toBase58(), secretKeyBase58: encodeBase58(keypair.secretKey) };
}

export async function runSeed(): Promise<SeedResult> {
  const env = loadScriptEnv();
  if (env.cluster !== "localnet") {
    throw new Error(`seed: CLUSTER must be "localnet" for the E2E suite, got "${env.cluster}"`);
  }
  const connection = createConnection(env.solanaRpcUrl);
  await assertGenesisHash(connection, env.cluster);

  // The admin key is required by the program itself (Config.admin is the
  // only identity `/admin` accepts -- admin.spec.ts's pause flow) and must
  // never be copied into a disposable fixture: it is loaded straight from
  // `keys/`/the CLI default wallet and used in place, never written
  // anywhere else. Maker and taker are *not* the operator/demo identities
  // at `keys/user-a.json`/`keys/user-b.json` -- those are shared, durable
  // fixtures other scripts (e.g. `make lifecycle`) also read/write.
  // Instead, generate fresh disposable keypairs here, scoped to this one
  // suite run and never persisted to `keys/`.
  const admin = resolveAdminKeypair(env.adminKeypairPath, { createIfMissing: false, allowCliFallback: true });
  const publisher = resolveKeypair(env.publisherKeypairPath, { createIfMissing: true });
  const maker: DemoUser = { label: "A", keypair: Keypair.generate() };
  const taker: DemoUser = { label: "B", keypair: Keypair.generate() };

  const bootstrapChain = new LifecycleChain(connection, admin, publisher, PublicKey.default);
  const config = await bootstrapChain.fetchConfig();
  if (!config) {
    throw new Error("seed: Config does not exist -- run `init-config` against this validator first");
  }
  if (config.oracleProvider !== "MockPyth") {
    throw new Error(`seed: Config.oracle_provider is "${config.oracleProvider}", expected MockPyth for this suite`);
  }

  const chain = new LifecycleChain(connection, admin, publisher, config.usdcMint);
  const capacity = config.defaultBookCapacity;

  log("funding maker/taker demo users");
  await fundDemoUsers(connection, env.cluster, chain, maker, taker, DEMO_USER_INITIAL_USDC);

  // `airdrop --create-keys` (run by the Makefile before this script) only airdrops SOL
  // to the admin key, not the publisher -- `scripts/lifecycle.ts`'s own preflight step
  // funds the publisher separately for the same reason: `mock_write_price` pays rent for
  // the price PDA it creates, and the publisher is the fee payer/rent payer for that call.
  const publisherBalance = await connection.getBalance(publisher.publicKey, "confirmed");
  const publisherMinLamports = Math.round(0.05 * LAMPORTS_PER_SOL);
  if (publisherBalance < publisherMinLamports) {
    const sig = await connection.requestAirdrop(publisher.publicKey, publisherMinLamports - publisherBalance);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    log(`airdropped publisher ${publisher.publicKey.toBase58()} to ${publisherMinLamports / LAMPORTS_PER_SOL} SOL`);
  }

  // --- Open market: maker mints pairs, then rests one ask and one bid ---
  log(`creating open market ${OPEN_TICKER} (closes in ${OPEN_CLOSE_IN_SECONDS}s)`);
  const nowOpen = Math.floor(Date.now() / 1000);
  const openDay = await createTodaysMarkets(chain, [OPEN_TICKER], OPEN_CLOSE_IN_SECONDS, capacity, nowOpen);
  const { marketAddress: openMarketAddress, market: openMarket } = await fetchAtmMarket(chain, openDay, OPEN_TICKER);

  await chain.mintPair(maker.keypair, openMarketAddress, openMarket, MAKER_MINT_QTY);
  log(`maker mint_pair(${MAKER_MINT_QTY}) on open market`);
  await chain.placeOrder(maker.keypair, openMarketAddress, openMarket, 1, MAKER_ASK_PRICE, MAKER_ASK_QTY, 0, []);
  log(`maker rests Ask ${MAKER_ASK_PRICE} x ${MAKER_ASK_QTY} on open market`);
  await chain.placeOrder(maker.keypair, openMarketAddress, openMarket, 0, MAKER_BID_PRICE, MAKER_BID_QTY, 0, []);
  log(`maker rests Bid ${MAKER_BID_PRICE} x ${MAKER_BID_QTY} on open market (flow 3's Buy No market crosses this)`);

  // --- Settled market: taker mints a pair up front, then this script waits it out and settles it ---
  log(`creating settled market ${SETTLED_TICKER} (closes in ${SETTLED_CLOSE_IN_SECONDS}s)`);
  // On-chain clock, not `Date.now()`: `close_ts`/`settle_market`'s guard are
  // both checked against the validator's `Clock` sysvar (see
  // `getOnChainUnixTimestamp`'s doc comment), which can already be behind
  // wall-clock time by the time this runs.
  const nowSettled = await getOnChainUnixTimestamp(connection);
  const settledDay = await createTodaysMarkets(chain, [SETTLED_TICKER], SETTLED_CLOSE_IN_SECONDS, capacity, nowSettled);
  const { marketAddress: settledMarketAddress, market: settledMarketBeforeClose } = await fetchAtmMarket(
    chain,
    settledDay,
    SETTLED_TICKER,
  );

  await chain.mintPair(taker.keypair, settledMarketAddress, settledMarketBeforeClose, TAKER_SETTLED_MINT_QTY);
  log(`taker mint_pair(${TAKER_SETTLED_MINT_QTY}) on settled-to-be market (holds both legs ahead of settlement)`);

  // Admin also mints a small pair here (admin is already the mint authority, so it
  // can fund its own USDC ATA directly) so `admin.spec.ts`'s flow 5 ("paused -> trade
  // disabled, redeem enabled") has something of its own to redeem while paused,
  // without needing a second identity in the one browser `admin.spec.ts` drives.
  const adminUsdcAta = await chain.usdcAta(admin.publicKey);
  const adminUsdcBalance = await chain.getTokenBalance(adminUsdcAta);
  const adminUsdcNeeded = ADMIN_SETTLED_MINT_QTY * ONE_USDC;
  if (adminUsdcBalance < adminUsdcNeeded) {
    await chain.fundUsdc(adminUsdcAta, adminUsdcNeeded - adminUsdcBalance);
  }
  await chain.mintPair(admin, settledMarketAddress, settledMarketBeforeClose, ADMIN_SETTLED_MINT_QTY);
  log(`admin mint_pair(${ADMIN_SETTLED_MINT_QTY}) on settled-to-be market (for admin.spec.ts's redeem-while-paused check)`);

  log("waiting for the settled market to close");
  await waitUntilClose(connection, settledDay.closeTs, log);

  log("publishing closing price and settling");
  const settled = await publishAndSettleAll(chain, settledDay, log);
  const settledInfo = settled.find((m) => m.market.equals(settledMarketAddress));
  if (!settledInfo || settledInfo.state !== "Settled") {
    throw new Error(`seed: settled market ${settledMarketAddress.toBase58()} did not settle`);
  }
  const settledMarket = await chain.fetchMarket(settledMarketAddress);
  if (!settledMarket) {
    throw new Error(`seed: settled market ${settledMarketAddress.toBase58()} vanished after settle`);
  }

  const result: SeedResult = {
    programId: PROGRAM_ID.toBase58(),
    rpcUrl: env.solanaRpcUrl,
    openMarket: {
      ticker: OPEN_TICKER,
      strike: openMarket.strike.toString(),
      pubkey: openMarketAddress.toBase58(),
      closeTs: openDay.closeTs,
    },
    settledMarket: {
      ticker: SETTLED_TICKER,
      strike: settledMarket.strike.toString(),
      pubkey: settledMarketAddress.toBase58(),
      closeTs: settledDay.closeTs,
      outcome: settledMarket.outcome === "Yes" ? "yes" : "no",
      settlementPrice: settledMarket.settlementPrice.toString(),
    },
    admin: { ...identityOf(admin), settledPairsMinted: ADMIN_SETTLED_MINT_QTY.toString() },
    maker: identityOf(maker.keypair),
    taker: { ...identityOf(taker.keypair), settledPairsMinted: TAKER_SETTLED_MINT_QTY.toString() },
  };

  writeFileSync(SEED_PATH, JSON.stringify(result, null, 2), { mode: 0o600 });
  chmodSync(SEED_PATH, 0o600);
  log(`wrote ${SEED_PATH}`);
  return result;
}

/**
 * Removes `SEED_DIR` (and the mode-0600 fixture file inside it, which holds
 * disposable-but-real maker/taker/admin secret keys) once the suite no
 * longer needs it. Called from `web/e2e/global-teardown.ts`.
 */
export function removeSeedFixture(): void {
  rmSync(SEED_DIR, { recursive: true, force: true });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runSeed().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
