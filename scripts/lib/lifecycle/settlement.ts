/**
 * Publish + settle for `scripts/lifecycle.ts` (tasks.md T086, steps 7-8):
 * for each ticker, write one closing mock price (strike + $5, so the ATM
 * strike resolves Yes -- brief step 7), then `settle_market` every market
 * created for that ticker this run. Waits for `now >= closeTs` first.
 */

import { feedIdBytes, type Ticker } from "@meridian/sdk";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { LifecycleChain } from "./chain.js";
import { FIVE_DOLLARS_MICRO, ONE_CENT_MICRO } from "./prices.js";
import type { SyntheticDay } from "./day.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

/**
 * Reads the on-chain `Clock` sysvar's `unix_timestamp` directly (layout:
 * `slot: u64, epoch_start_timestamp: i64, epoch: u64, leader_schedule_epoch:
 * u64, unix_timestamp: i64`, all little-endian -- `unix_timestamp` is the
 * last 8 bytes). `settle_market`'s `now < close_ts` guard (`BeforeClose`)
 * is checked against *this* clock, not wall-clock time: a `solana-test-validator`
 * under load (e.g. the 150+ transactions this script sends to set up a
 * full seven-ticker day) can have its on-chain clock lag noticeably behind
 * the host's `Date.now()`, so waiting on wall-clock time alone can still
 * hit `BeforeClose` once the settle call actually lands. This is the same
 * clock `Clock::get()?.unix_timestamp` reads inside the program.
 */
export async function getOnChainUnixTimestamp(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(CLOCK_SYSVAR, "confirmed");
  if (!info) {
    throw new Error("getOnChainUnixTimestamp: no account at the Clock sysvar address");
  }
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  return Number(view.getBigInt64(32, true));
}

/** Blocks (polling every second) until the on-chain `Clock` sysvar reaches `closeTsSeconds`. */
export async function waitUntilClose(
  connection: Connection,
  closeTsSeconds: number,
  log: (line: string) => void,
): Promise<void> {
  let onChainNow = await getOnChainUnixTimestamp(connection);
  const remaining = closeTsSeconds - onChainNow;
  if (remaining > 0) {
    log(`waiting ~${remaining}s for on-chain close_ts=${closeTsSeconds} (on-chain clock currently ${onChainNow})`);
  }
  while (onChainNow < closeTsSeconds) {
    await sleep(1000);
    onChainNow = await getOnChainUnixTimestamp(connection);
  }
}

export interface SettledMarketInfo {
  ticker: Ticker;
  strike: bigint;
  market: PublicKey;
  state: "Open" | "Settled";
  outcome: "Unset" | "Yes" | "No";
}

/** Publishes one closing price per ticker (strike + $5 off that ticker's ATM strike) and settles every market created this run. */
export async function publishAndSettleAll(
  chain: LifecycleChain,
  day: SyntheticDay,
  log: (line: string) => void,
): Promise<SettledMarketInfo[]> {
  // `publish_time` must read as "at/after close" from the chain's own clock (the
  // `OracleTooOld`/`OracleStale` guards both compare against it, not wall-clock time --
  // see `getOnChainUnixTimestamp`'s doc comment).
  const nowSeconds = await getOnChainUnixTimestamp(chain.connection);
  const results: SettledMarketInfo[] = [];

  for (const [ticker, tickerDay] of day.byTicker.entries()) {
    const closingPrice = tickerDay.atmStrike + FIVE_DOLLARS_MICRO;
    const priceAccount = await chain.mockWritePrice(feedIdBytes(ticker), closingPrice, ONE_CENT_MICRO, -6, nowSeconds);
    log(`mock_write_price ${ticker} price=${closingPrice} -> ${priceAccount.toBase58()}`);

    for (const [strikeStr, market] of tickerDay.strikesToMarkets.entries()) {
      await chain.settleMarket(market, priceAccount);
      const fresh = await chain.fetchMarket(market);
      if (!fresh) throw new Error(`publishAndSettleAll: market ${market.toBase58()} vanished after settle`);
      if (fresh.state !== "Settled") {
        throw new Error(`publishAndSettleAll: market ${market.toBase58()} is "${fresh.state}" after settle_market`);
      }
      log(`settle_market ${ticker} strike=${strikeStr} -> ${market.toBase58()} outcome=${fresh.outcome}`);
      results.push({ ticker, strike: BigInt(strikeStr), market, state: fresh.state, outcome: fresh.outcome });
    }
  }

  return results;
}
