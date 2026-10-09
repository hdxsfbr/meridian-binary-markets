/**
 * `MockPyth` price provider (contracts/oracle-provider.md, tasks.md T043):
 * cross-checks Finnhub against Nasdaq (research.md R12) and writes the
 * result on chain via `mock_write_price`, signed by the publisher key.
 *
 * `publish` writes Finnhub's current price as the canonical reading (it is
 * the lower-latency, authenticated source); `conf` captures how far Nasdaq's
 * independent reading disagrees, floored at 10_000 micro-USD ($0.01) so a
 * confidence of zero is never reported even when the two sources happen to
 * agree exactly. If either source fails, nothing is written (`Promise.all`
 * rejects before `chain.mockWritePrice` is ever called).
 *
 * `publish_time` is always a *source* timestamp (the earlier of Finnhub's
 * trade time and Nasdaq's last-trade time), never `now()`: the on-chain
 * freshness/close-relevance guards (contracts/oracle-provider.md "Program
 * side": `OracleStale`, `OracleTooOld`) only mean anything if `publish_time`
 * reflects when the price was actually observed. If that source timestamp is
 * already more than `STALE_SOURCE_SECS` old by the time we're about to
 * write, the write is refused outright (fail closed) rather than publishing
 * a stale reading under a fresh-looking wall-clock time.
 */

import type { PublicKey } from "@solana/web3.js";
import { feedIdBytes, type MicroUsd, type Ticker } from "@meridian/sdk";
import { fetchFinnhubQuote } from "../sources/finnhub.js";
import { fetchNasdaqQuote } from "../sources/nasdaq.js";
import { logError } from "../log.js";
import type { PriceProvider, PublishResult } from "./PriceProvider.js";

/** The slice of `ChainClient` this provider needs; kept narrow so tests can mock it trivially. */
export interface MockPythChain {
  mockWritePrice(
    feedId: Uint8Array,
    price: bigint,
    conf: bigint,
    expo: number,
    publishTime: number,
  ): Promise<PublicKey>;
  /**
   * Used to resolve each ticker's feed id from the on-chain `Config`
   * (fix #13: the feed id binding is configurable on chain, so the SDK's
   * hardcoded constant is only ever a fallback).
   */
  fetchConfig(): Promise<{
    tickers: Array<{ symbol: Ticker; feedId: Uint8Array; enabled: boolean }>;
  }>;
}

/** Floor for `conf`, in micro-USD ($0.01), applied even when the two sources agree exactly. */
const MIN_CONF_MICRO_USD = 10_000n;

/** Pyth-style exponent for mock writes: price/conf are expressed directly in micro-USD. */
const MOCK_EXPO = -6;

/**
 * Cross-check tolerance for `previousClose`: 10% == 1_000 basis points.
 *
 * This is deliberately wide. Finnhub's `pc` is an actual previous-session
 * close; Nasdaq's quote here is its *latest* trade, which — unlike Finnhub's
 * `pc` — is not itself a previous close and can legitimately differ from it
 * by a full day's price movement (including after-hours/pre-market moves).
 * The Nasdaq reading is therefore only a sanity bound against a wildly wrong
 * Finnhub value, not an equivalence check against an equivalent observation.
 */
const PREVIOUS_CLOSE_TOLERANCE_BPS = 1_000n;

/**
 * Cross-check tolerance for `currentPrice`: 10% == 1_000 basis points, same bound as
 * `previousClose` -- Finnhub's `c` and Nasdaq's latest trade are both genuinely "current"
 * readings here (unlike `previousClose`'s Finnhub-`pc`-vs-Nasdaq-latest comparison), so in
 * practice they should usually agree far more tightly than this; the wide bound only guards
 * against a wildly wrong reading from either source.
 */
const CURRENT_PRICE_TOLERANCE_BPS = 1_000n;

/** Fail closed if the source observation backing a publish is older than this, in seconds. */
const STALE_SOURCE_SECS = 300;

export interface MockPythProviderDeps {
  chain: MockPythChain;
  finnhubApiKey: string;
  /** Injectable for tests; defaults to the real HTTP sources. */
  fetchFinnhub?: typeof fetchFinnhubQuote;
  fetchNasdaq?: typeof fetchNasdaqQuote;
  /** Injectable clock, unix seconds; defaults to wall-clock `Date.now`. */
  now?: () => number;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

export class MockPythProvider implements PriceProvider {
  private readonly chain: MockPythChain;
  private readonly finnhubApiKey: string;
  private readonly fetchFinnhub: typeof fetchFinnhubQuote;
  private readonly fetchNasdaq: typeof fetchNasdaqQuote;
  private readonly now: () => number;

  constructor(deps: MockPythProviderDeps) {
    if (!deps.finnhubApiKey) {
      throw new Error("MockPythProvider: finnhubApiKey is required");
    }
    this.chain = deps.chain;
    this.finnhubApiKey = deps.finnhubApiKey;
    this.fetchFinnhub = deps.fetchFinnhub ?? fetchFinnhubQuote;
    this.fetchNasdaq = deps.fetchNasdaq ?? fetchNasdaqQuote;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Resolves `ticker`'s feed id from the on-chain `Config.tickers` (fix
   * #13). Falls back to the SDK's hardcoded constant (and logs it) only
   * when `Config` doesn't carry an entry for this ticker, or can't be
   * fetched at all.
   */
  private async resolveFeedId(ticker: Ticker): Promise<Uint8Array> {
    try {
      const config = await this.chain.fetchConfig();
      const entry = config.tickers.find((t) => t.symbol === ticker);
      if (entry) return entry.feedId;
      logError({
        job: "oracle_provider",
        ticker,
        step: "resolve_feed_id",
        ok: false,
        error: `Config.tickers has no entry for ${ticker}; falling back to the SDK constant feed id`,
      });
    } catch (err) {
      logError({
        job: "oracle_provider",
        ticker,
        step: "resolve_feed_id",
        ok: false,
        error: `fetchConfig failed while resolving feed id, falling back to the SDK constant: ${(err as Error).message}`,
      });
    }
    return feedIdBytes(ticker);
  }

  async publish(ticker: Ticker): Promise<PublishResult> {
    // Both sources are fetched before either result is used: a failure from
    // either throws here, before `chain.mockWritePrice` is ever called, so a
    // one-sided outage never produces a write (T043).
    const [finnhub, nasdaq] = await Promise.all([
      this.fetchFinnhub(ticker, this.finnhubApiKey),
      this.fetchNasdaq(ticker),
    ]);

    const disagreement = absDiff(finnhub.current.priceMicro, nasdaq.priceMicro);
    const conf = disagreement > MIN_CONF_MICRO_USD ? disagreement : MIN_CONF_MICRO_USD;

    // publish_time is a *source* timestamp (fix #3): the earlier of the two
    // sources' own observation times, never `now()`. Using the earlier one
    // is the conservative choice -- it never overstates freshness.
    const publishTime = Math.min(finnhub.tradeTime, nasdaq.observedAt);

    const age = this.now() - publishTime;
    if (age > STALE_SOURCE_SECS) {
      throw new Error(
        `MockPythProvider.publish: ${ticker} source observation (publishTime=${publishTime}) is ` +
          `${age}s old, which exceeds the ${STALE_SOURCE_SECS}s staleness threshold; refusing to write`,
      );
    }

    const feedId = await this.resolveFeedId(ticker);

    const priceAccount = await this.chain.mockWritePrice(
      feedId,
      finnhub.current.priceMicro,
      conf,
      MOCK_EXPO,
      publishTime,
    );

    return { priceAccount, publishTime };
  }

  async previousClose(ticker: Ticker): Promise<MicroUsd> {
    const [finnhub, nasdaq] = await Promise.all([
      this.fetchFinnhub(ticker, this.finnhubApiKey),
      this.fetchNasdaq(ticker),
    ]);

    const pc = finnhub.previousClose;
    const disagreement = absDiff(pc, nasdaq.priceMicro);
    // disagreement / pc <= 10%  <=>  disagreement * 10_000 <= pc * 1_000
    if (disagreement * 10_000n > pc * PREVIOUS_CLOSE_TOLERANCE_BPS) {
      throw new Error(
        `MockPythProvider.previousClose: ${ticker} Finnhub previous close (${pc}) and Nasdaq price ` +
          `(${nasdaq.priceMicro}) disagree by more than 10%`,
      );
    }

    return pc as MicroUsd;
  }

  /**
   * Live price for the `extend` job's ladder-extension check (jobs/extend.ts). Same
   * dual-source cross-check shape as `publish`/`previousClose`: Finnhub's `c` is the
   * canonical reading, Nasdaq's latest trade is the sanity bound.
   *
   * Review fix: `publish` never trusts an old source observation under a fresh-looking
   * wall-clock time (its own `STALE_SOURCE_SECS` check); this method previously skipped
   * that check entirely, so two *agreeing* but stale quotes passed the cross-check above
   * and could trigger an extension. Applies the same freshness policy here: the earlier of
   * the two sources' own observation times (never `now()`), checked against the same
   * `STALE_SOURCE_SECS` bound `publish` uses.
   */
  async currentPrice(ticker: Ticker): Promise<MicroUsd> {
    const [finnhub, nasdaq] = await Promise.all([
      this.fetchFinnhub(ticker, this.finnhubApiKey),
      this.fetchNasdaq(ticker),
    ]);

    const current = finnhub.current.priceMicro;
    const disagreement = absDiff(current, nasdaq.priceMicro);
    if (disagreement * 10_000n > current * CURRENT_PRICE_TOLERANCE_BPS) {
      throw new Error(
        `MockPythProvider.currentPrice: ${ticker} Finnhub current price (${current}) and Nasdaq price ` +
          `(${nasdaq.priceMicro}) disagree by more than 10%`,
      );
    }

    const observedAt = Math.min(finnhub.tradeTime, nasdaq.observedAt);
    const age = this.now() - observedAt;
    if (age > STALE_SOURCE_SECS) {
      throw new Error(
        `MockPythProvider.currentPrice: ${ticker} source observation (observedAt=${observedAt}) is ` +
          `${age}s old, which exceeds the ${STALE_SOURCE_SECS}s staleness threshold`,
      );
    }

    return current as MicroUsd;
  }
}
