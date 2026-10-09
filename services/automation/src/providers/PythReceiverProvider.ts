/**
 * `PythReceiver` price provider (contracts/oracle-provider.md, tasks.md T091):
 * `publish` fetches the latest Hermes update for the ticker's feed id and posts it to
 * Pyth's devnet receiver program via `@pythnetwork/pyth-solana-receiver`, returning the
 * ephemeral `PriceUpdateV2` account `settle_market` should read. `previousClose` reads
 * Hermes's historical endpoint at the previous trading day's close timestamp, falling
 * back to Finnhub if Hermes fails or returns an observation too far from that close
 * (e.g. a 403 "Not entitled" feed, DECISIONS §8).
 *
 * DECISIONS §8: `@pythnetwork/pyth-solana-receiver` pins `@coral-xyz/anchor ^0.29`, a
 * different major than this service's own `@anchor-lang/core` 1.2.1. That dependency,
 * and its transitive `@coral-xyz/anchor`, are only ever imported from this file and
 * `src/probe/pyth.ts` -- nothing else in the service touches them, so the pin never
 * leaks into `chain.ts`'s Anchor client.
 *
 * Wave 6 fix #1: posting uses the SDK's own `PythTransactionBuilder`
 * (`receiver.newTransactionBuilder`) rather than hand-packing every receiver
 * instruction into a single transaction -- a real update's `postInstructions` (the
 * encoded-VAA write plus the price-update post) does not fit in one packet. The builder
 * splits them into correctly sized versioned transactions, which are sent and confirmed
 * **in order** (each one's effects, e.g. the encoded-VAA account, are depended on by the
 * next). `closeUpdateAccounts: false` (brief): the builder is configured to never add
 * its paired close instructions, so the posted `PriceUpdateV2` account stays alive on
 * chain for `settle_market` (and, in the real demo, for the window between publish and
 * settle) to read.
 */

import { createRequire } from "node:module";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

import type { MicroUsd, Ticker } from "@meridian/sdk";

/**
 * Mirrors `@pythnetwork/solana-utils`'s `PriorityFeeConfig` (a transitive dependency
 * of `@pythnetwork/pyth-solana-receiver`, not one this package depends on directly, so
 * its types aren't resolvable under pnpm's isolated `node_modules` -- inlined here
 * rather than adding a new direct dependency for one structural type).
 */
export type PriorityFeeConfig = {
  computeUnitPriceMicroLamports?: number;
  tightComputeBudget?: boolean;
  jitoTipLamports?: number;
};

// `@pythnetwork/pyth-solana-receiver` (pinned to the Node-22-compatible 0.13.0,
// DECISIONS.md §8/fix #7) ships a pure-CJS `dist/index.cjs` with no `import` condition
// in its `exports` map. Loading it via `createRequire` rather than a plain ESM `import`
// avoids relying on Node's cjs-module-lexer named-export detection for that build. The
// type-only import above is erased at compile time and never touches this at runtime.
const requireCjs = createRequire(import.meta.url);
const { PythSolanaReceiver } = requireCjs("@pythnetwork/pyth-solana-receiver") as {
  PythSolanaReceiver: new (args: {
    connection: Connection;
    wallet: unknown;
    receiverProgramId: PublicKey;
  }) => {
    newTransactionBuilder: (config: { closeUpdateAccounts?: boolean }) => {
      addPostPriceUpdates: (updates: string[]) => Promise<void>;
      buildVersionedTransactions: (
        args: PriorityFeeConfig,
      ) => Promise<{ tx: VersionedTransaction; signers: Keypair[] }[]>;
      getPriceUpdateAccount: (priceFeedId: string) => PublicKey;
    };
  };
};
import { fetchFinnhubQuote } from "../sources/finnhub.js";
import { fetchHistoricalUpdate, fetchLatestUpdate } from "../sources/hermes.js";
import { closeTs, ET_ZONE, isTradingDay, staticHolidaysFor, tradingDayOf } from "../calendar.js";
import { logError } from "../log.js";
import type { PriceProvider, PublishResult } from "./PriceProvider.js";
import { DateTime } from "luxon";

/** The slice of `ChainClient` this provider needs: resolving a ticker's feed id. */
export interface PythReceiverChain {
  fetchConfig(): Promise<{
    tickers: Array<{ symbol: Ticker; feedId: Uint8Array; enabled: boolean }>;
  }>;
}

/** Minimal wallet shape `PythSolanaReceiver`'s internal `AnchorProvider` expects. */
interface SigningWallet {
  publicKey: PublicKey;
  payer: Keypair;
  signTransaction: <T extends VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends VersionedTransaction>(txs: T[]) => Promise<T[]>;
}

function walletFor(keypair: Keypair): SigningWallet {
  return {
    publicKey: keypair.publicKey,
    payer: keypair,
    signTransaction: async (tx) => {
      tx.sign([keypair]);
      return tx;
    },
    signAllTransactions: async (txs) => {
      for (const tx of txs) tx.sign([keypair]);
      return txs;
    },
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export interface PythReceiverProviderDeps {
  chain: PythReceiverChain;
  connection: Connection;
  publisherKeypair: Keypair;
  receiverProgramId: PublicKey;
  hermesBaseUrl: string;
  pythApiKey: string;
  finnhubApiKey?: string;
  /** Injectable for tests; defaults to the real Hermes/chain calls. */
  fetchLatest?: typeof fetchLatestUpdate;
  fetchHistorical?: typeof fetchHistoricalUpdate;
  fetchFinnhub?: typeof fetchFinnhubQuote;
  /** Injectable for tests so a real `PythSolanaReceiver`/network call is never needed. */
  postUpdate?: (binary: Uint8Array, feedIdHex: string) => Promise<{ priceAccount: PublicKey }>;
  /** Injectable clock, unix seconds; defaults to wall-clock `Date.now`. */
  now?: () => number;
}

export class PythReceiverProvider implements PriceProvider {
  private readonly chain: PythReceiverChain;
  private readonly connection: Connection;
  private readonly publisherKeypair: Keypair;
  private readonly receiverProgramId: PublicKey;
  private readonly hermesBaseUrl: string;
  private readonly pythApiKey: string;
  private readonly finnhubApiKey?: string;
  private readonly fetchLatest: typeof fetchLatestUpdate;
  private readonly fetchHistorical: typeof fetchHistoricalUpdate;
  private readonly fetchFinnhub: typeof fetchFinnhubQuote;
  private readonly postUpdate: (binary: Uint8Array, feedIdHex: string) => Promise<{ priceAccount: PublicKey }>;
  private readonly now: () => number;

  constructor(deps: PythReceiverProviderDeps) {
    this.chain = deps.chain;
    this.connection = deps.connection;
    this.publisherKeypair = deps.publisherKeypair;
    this.receiverProgramId = deps.receiverProgramId;
    this.hermesBaseUrl = deps.hermesBaseUrl;
    this.pythApiKey = deps.pythApiKey;
    this.finnhubApiKey = deps.finnhubApiKey;
    this.fetchLatest = deps.fetchLatest ?? fetchLatestUpdate;
    this.fetchHistorical = deps.fetchHistorical ?? fetchHistoricalUpdate;
    this.fetchFinnhub = deps.fetchFinnhub ?? fetchFinnhubQuote;
    this.postUpdate = deps.postUpdate ?? ((binary, feedIdHex) => this.postUpdateToReceiver(binary, feedIdHex));
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private async resolveFeedIdHex(ticker: Ticker): Promise<string> {
    const config = await this.chain.fetchConfig();
    const entry = config.tickers.find((t) => t.symbol === ticker);
    if (!entry) {
      throw new Error(`PythReceiverProvider: Config.tickers has no entry for ${ticker}`);
    }
    return bytesToHex(entry.feedId);
  }

  /**
   * Posts `binary` (the Hermes accumulator update) to the devnet receiver program via
   * the SDK's `PythTransactionBuilder` (fix #1), signed by the publisher keypair. The
   * builder splits the post into one or more correctly sized versioned transactions,
   * which are signed and sent/confirmed **in order** -- later transactions in the batch
   * depend on accounts earlier ones create. `closeUpdateAccounts: false` means the
   * builder never appends its paired close instructions (see this module's doc
   * comment), so the resulting `PriceUpdateV2` account stays readable by
   * `settle_market`. Fix #6: each confirmation's `value.err` is checked -- a confirmed
   * but failed transaction throws here rather than being reported as a successful
   * publish.
   */
  private async postUpdateToReceiver(binary: Uint8Array, feedIdHex: string): Promise<{ priceAccount: PublicKey }> {
    const wallet = walletFor(this.publisherKeypair);
    const receiver = new PythSolanaReceiver({
      connection: this.connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: wallet as any,
      receiverProgramId: this.receiverProgramId,
    });

    const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
    const base64Update = Buffer.from(binary).toString("base64");
    await builder.addPostPriceUpdates([base64Update]);
    const transactions = await builder.buildVersionedTransactions({});

    await sendTransactionsInOrder(this.connection, this.publisherKeypair, transactions);

    const priceAccount = builder.getPriceUpdateAccount(`0x${feedIdHex}`);
    return { priceAccount };
  }

  async publish(ticker: Ticker): Promise<PublishResult> {
    const feedIdHex = await this.resolveFeedIdHex(ticker);
    const update = await this.fetchLatest(feedIdHex, {
      baseUrl: this.hermesBaseUrl,
      apiKey: this.pythApiKey,
    });

    const { priceAccount } = await this.postUpdate(update.binary, feedIdHex);

    return { priceAccount, publishTime: update.parsed.publishTime };
  }

  async previousClose(ticker: Ticker): Promise<MicroUsd> {
    const feedIdHex = await this.resolveFeedIdHex(ticker);
    // Fix #3: anchor on the PREVIOUS TRADING DAY's close (16:00 ET, calendar-aware via
    // calendar.ts, holidays included), not a naive "now minus 24h", which is wrong
    // after every weekend (and any holiday).
    const today = tradingDayOf(this.now());
    const previousDay = previousTradingDay(today);
    const anchorTs = closeTs(previousDay);

    try {
      const update = await this.fetchHistorical(feedIdHex, anchorTs, {
        baseUrl: this.hermesBaseUrl,
        apiKey: this.pythApiKey,
      });
      const driftSecs = Math.abs(update.parsed.publishTime - anchorTs);
      if (driftSecs > PREVIOUS_CLOSE_TOLERANCE_SECS) {
        throw new Error(
          `PythReceiverProvider.previousClose: Hermes publish_time ${update.parsed.publishTime} for ${ticker} ` +
            `is ${driftSecs}s from the expected previous trading day (${previousDay}) close ${anchorTs}, ` +
            `outside the ${PREVIOUS_CLOSE_TOLERANCE_SECS}s tolerance`,
        );
      }
      return normalizeToMicroUsd(update.parsed.price, update.parsed.expo);
    } catch (err) {
      logError({
        job: "oracle_provider",
        ticker,
        step: "previous_close",
        ok: false,
        error: `Hermes historical read failed or was out of tolerance, falling back to Finnhub: ${(err as Error).message}`,
      });
      if (!this.finnhubApiKey) {
        throw new Error(
          `PythReceiverProvider.previousClose: Hermes failed for ${ticker} and no FINNHUB_API_KEY fallback is configured`,
        );
      }
      const finnhub = await this.fetchFinnhub(ticker, this.finnhubApiKey);
      return finnhub.previousClose as MicroUsd;
    }
  }

  /**
   * Live price for the `extend` job's ladder-extension check (jobs/extend.ts): the same
   * Hermes "latest update" read `publish` posts on chain, but read-only here -- `extend`
   * only needs the price, never a `PriceUpdateV2` account, so this never calls
   * `postUpdate`/touches the chain.
   *
   * Review fix: unlike `publish` (which the on-chain `OracleStale`/`OracleTooOld` guards
   * validate) and `previousClose` (which checks drift against the expected close), nothing
   * downstream of this method ever validates the observation -- `extend`'s two-consecutive-
   * tick edge detection would otherwise happily act on an ancient or wildly-uncertain
   * reading. Validated here instead, before the price is ever returned: freshness (reusing
   * `previousClose`'s own `PREVIOUS_CLOSE_TOLERANCE_SECS` tolerance -- the same provider,
   * the same Hermes endpoint, the same "how old is too old" bound), a positive price, and
   * confidence within `MAX_CONFIDENCE_BPS` of the price (mirroring `MockPythProvider`'s
   * `CURRENT_PRICE_TOLERANCE_BPS`, so both `PriceProvider` implementations apply a
   * comparably wide sanity bound). Throws a descriptive error rather than returning an
   * invalid observation.
   */
  async currentPrice(ticker: Ticker): Promise<MicroUsd> {
    const feedIdHex = await this.resolveFeedIdHex(ticker);
    const update = await this.fetchLatest(feedIdHex, {
      baseUrl: this.hermesBaseUrl,
      apiKey: this.pythApiKey,
    });
    const { price, conf, expo, publishTime } = update.parsed;

    const age = this.now() - publishTime;
    if (age > PREVIOUS_CLOSE_TOLERANCE_SECS) {
      throw new Error(
        `PythReceiverProvider.currentPrice: ${ticker} Hermes publish_time ${publishTime} is ${age}s old, ` +
          `exceeding the ${PREVIOUS_CLOSE_TOLERANCE_SECS}s staleness limit`,
      );
    }
    if (price <= 0n) {
      throw new Error(`PythReceiverProvider.currentPrice: ${ticker} Hermes price ${price} is not positive`);
    }
    // conf/price > MAX_CONFIDENCE_BPS/10_000  <=>  conf * 10_000 > price * MAX_CONFIDENCE_BPS
    if (conf * 10_000n > price * MAX_CONFIDENCE_BPS) {
      throw new Error(
        `PythReceiverProvider.currentPrice: ${ticker} Hermes confidence ${conf} is more than ` +
          `${MAX_CONFIDENCE_BPS}bps of price ${price}; refusing to use this observation`,
      );
    }

    return normalizeToMicroUsd(price, expo);
  }
}

/**
 * Review fix: confidence-width sanity bound for `currentPrice`, mirroring
 * `MockPythProvider`'s `CURRENT_PRICE_TOLERANCE_BPS` (10%) so both `PriceProvider`
 * implementations apply a comparably wide bound against a wildly-uncertain reading.
 */
const MAX_CONFIDENCE_BPS = 1_000n;

/** Fix #3: Hermes's historical observation must land within 5 minutes of the expected close. */
const PREVIOUS_CLOSE_TOLERANCE_SECS = 5 * 60;

/**
 * The trading day (`YYYYMMDD`) strictly before `day`, skipping weekends and NYSE
 * holidays (fix #3) -- the mirror of `calendar.ts`'s `nextTradingDay`, walking
 * backward instead of forward. Built from `calendar.ts`'s already-exported
 * `isTradingDay`/`staticHolidaysFor` rather than a new export there, since this is the
 * only caller.
 */
function previousTradingDay(day: number): number {
  const s = String(day);
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const dayOfMonth = Number(s.slice(6, 8));
  let dt = DateTime.fromObject({ year, month, day: dayOfMonth }, { zone: ET_ZONE }).minus({ days: 1 });
  if (!dt.isValid) {
    throw new Error(`previousTradingDay: invalid trading day ${day}: ${dt.invalidReason}`);
  }
  for (let i = 0; i < 3650; i += 1) {
    const candidate = Number(dt.toFormat("yyyyMMdd"));
    if (isTradingDay(candidate, staticHolidaysFor(dt.year))) {
      return candidate;
    }
    dt = dt.minus({ days: 1 });
  }
  throw new Error(`previousTradingDay: no trading day found within 10 years before ${day}`);
}

/** Minimal connection shape `sendTransactionsInOrder` needs -- easy to fake in tests. */
export interface TransactionSender {
  sendTransaction(tx: VersionedTransaction, opts?: { skipPreflight?: boolean }): Promise<string>;
  confirmTransaction(signature: string, commitment?: string): Promise<{ value: { err: unknown } }>;
}

/**
 * Sends and confirms a `PythTransactionBuilder` batch **in order** (fix #1): later
 * transactions in the batch (e.g. the price-update post) depend on accounts earlier
 * ones create (e.g. the encoded-VAA write), so they cannot be sent concurrently or
 * out of order. Fix #6: each confirmation's `value.err` is checked -- a confirmed but
 * failed transaction throws immediately here rather than being treated as a
 * successful publish (and later transactions in the batch are never sent).
 */
export async function sendTransactionsInOrder(
  connection: TransactionSender,
  signer: Keypair,
  transactions: { tx: VersionedTransaction; signers: Keypair[] }[],
): Promise<void> {
  for (const { tx, signers } of transactions) {
    tx.sign([signer, ...signers]);
    const signature = await connection.sendTransaction(tx, { skipPreflight: false });
    const { value } = await connection.confirmTransaction(signature, "confirmed");
    if (value.err) {
      throw new Error(
        `PythReceiverProvider: posting transaction ${signature} confirmed with an error: ${JSON.stringify(value.err)}`,
      );
    }
  }
}

/**
 * Normalizes a Pyth `(price, expo)` pair to micro-USD: `price * 10^expo` is the actual
 * dollar value, and micro-USD is that value `* 1e6`, so the combined exponent is
 * `expo + 6` (e.g. `expo = -8` -> divide by `10^2`; `expo = -6` -> unchanged).
 */
function normalizeToMicroUsd(price: bigint, expo: number): MicroUsd {
  const shift = expo + 6;
  const result = shift >= 0 ? price * 10n ** BigInt(shift) : price / 10n ** BigInt(-shift);
  return result as MicroUsd;
}
