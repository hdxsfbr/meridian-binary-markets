/**
 * Thin, typed Anchor client for the automation service. Wraps the generated
 * `IDL` (`packages/sdk/src/idl.ts`) in a `Program` and exposes one method per
 * on-chain instruction the jobs need, plus a couple of read helpers. Account
 * addresses are always derived locally via `packages/sdk/src/pda.ts` rather
 * than left to Anchor's automatic resolver, so every transaction this file
 * builds is fully explicit and easy to reason about in tests.
 *
 * `AlreadySettled` from `settle_market` is a normal, expected outcome (FR-021:
 * the service treats a second settle call as success); this module surfaces
 * it as a typed predicate (`isAlreadySettledError`) rather than swallowing it,
 * so the caller (jobs/settle.ts) decides what "success" means.
 */

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  type GetProgramAccountsFilter,
} from "@solana/web3.js";
// `@anchor-lang/core` ships CJS with getter-based named exports
// (`Object.defineProperty(exports, "BN", { get: ... })`); Node's ESM-CJS
// named-export detection doesn't reliably see through that under the real
// `tsx` entry point (it works fine through vitest/vite's own resolver,
// which is why this only ever showed up in the CLI smoke test, fix #1).
// A default import of the whole CJS `module.exports` object, destructured
// at runtime instead of statically, always works regardless of that
// detection.
import AnchorLangCore from "@anchor-lang/core";
const { AnchorProvider, BN, Program, Wallet, utils } = AnchorLangCore;
import {
  IDL,
  PROGRAM_ID,
  bookPda,
  configPda,
  decodeBook,
  marketPda,
  mockPricePda,
  noMintPda,
  tickerSymbolBytes,
  usdcEscrowPda,
  vaultPda,
  yesEscrowPda,
  yesMintPda,
  type BookHeader,
  type Ticker,
} from "@meridian/sdk";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** mainnet-beta's well-known genesis hash. Refused outright, regardless of `SOLANA_CLUSTER`. */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** devnet's well-known genesis hash. Required when `SOLANA_CLUSTER=devnet`. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/**
 * Fix #3: refuses to proceed if `connection` is pointed at the wrong
 * cluster, checked via its genesis hash rather than trusting
 * `SOLANA_RPC_URL`'s hostname: mainnet-beta's genesis hash is refused
 * unconditionally (this service never targets mainnet, no matter what
 * `SOLANA_CLUSTER` says), `SOLANA_CLUSTER=devnet` additionally requires
 * devnet's own genesis hash, and `SOLANA_CLUSTER=localnet` accepts any
 * genesis hash that isn't mainnet's. Called once at startup, before any
 * transaction.
 */
export async function assertGenesisHash(connection: Connection, cluster: "devnet" | "localnet"): Promise<void> {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash === MAINNET_GENESIS_HASH) {
    throw new Error(
      `assertGenesisHash: refusing to proceed -- the RPC endpoint's genesis hash (${genesisHash}) is mainnet-beta's; this service never targets mainnet`,
    );
  }
  if (cluster === "devnet" && genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `assertGenesisHash: refusing to proceed -- SOLANA_CLUSTER=devnet but the RPC endpoint's genesis hash is "${genesisHash}", expected devnet's "${DEVNET_GENESIS_HASH}"`,
    );
  }
}

/** Anchor's `AlreadySettled` error code (programs/meridian/src/errors.rs). */
const ALREADY_SETTLED_CODE = "AlreadySettled";

/** True if `err` is the on-chain `AlreadySettled` Anchor error. */
export function isAlreadySettledError(err: unknown): boolean {
  const anyErr = err as { error?: { errorCode?: { code?: string } }; message?: string } | undefined;
  if (anyErr?.error?.errorCode?.code === ALREADY_SETTLED_CODE) return true;
  if (typeof anyErr?.message === "string" && anyErr.message.includes(ALREADY_SETTLED_CODE)) return true;
  return false;
}

/** Shape of the on-chain `TickerInfo` entry inside `Config.tickers`, decoded. */
export interface TickerInfoAccount {
  symbol: Ticker;
  feedId: Uint8Array;
  enabled: boolean;
}

/** Shape of the on-chain `Config` singleton, decoded. */
export interface ConfigAccount {
  admin: PublicKey;
  paused: boolean;
  usdcMint: PublicKey;
  oracleProvider: "mock" | "pyth";
  oracleProgram: PublicKey;
  publishers: PublicKey[];
  maxStalenessSecs: number;
  maxConfBps: number;
  minPublishOffsetSecs: number;
  overrideDelaySecs: number;
  tickers: TickerInfoAccount[];
  defaultBookCapacity: number;
  bump: number;
}

/** Shape of the on-chain `Market` account, decoded. */
export interface MarketAccount {
  ticker: Ticker;
  strike: bigint;
  tradingDay: number;
  closeTs: number;
  state: "Open" | "Settled";
  outcome: "Unset" | "Yes" | "No";
  settlementPrice: bigint;
  settledAt: number;
  settledByOverride: boolean;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  book: PublicKey;
  bookCapacity: number;
  pairsOutstanding: bigint;
}

export interface MarketRecord {
  publicKey: PublicKey;
  account: MarketAccount;
}

function bnToBigint(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (v instanceof BN) return BigInt((v as InstanceType<typeof BN>).toString());
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  throw new Error(`chain.ts: cannot convert ${String(v)} to bigint`);
}

function tickerFromSymbolBytes(bytes: Uint8Array | number[]): Ticker {
  const arr = Uint8Array.from(bytes as Iterable<number>);
  let end = arr.length;
  while (end > 0 && arr[end - 1] === 0) end -= 1;
  return Buffer.from(arr.slice(0, end)).toString("ascii") as Ticker;
}

function decodeConfig(raw: Record<string, unknown>): ConfigAccount {
  const tickers = (raw.tickers as Array<Record<string, unknown>>).map((t) => ({
    symbol: tickerFromSymbolBytes(t.symbol as number[]),
    feedId: Uint8Array.from(t.feedId as number[]),
    enabled: Boolean(t.enabled),
  }));
  return {
    admin: raw.admin as PublicKey,
    paused: Boolean(raw.paused),
    usdcMint: raw.usdcMint as PublicKey,
    oracleProvider: isMockProviderVariant(raw.oracleProvider) ? "mock" : "pyth",
    oracleProgram: raw.oracleProgram as PublicKey,
    publishers: (raw.publishers as PublicKey[]).slice(0, Number(raw.publishersLen ?? 0)),
    maxStalenessSecs: Number(raw.maxStalenessSecs),
    maxConfBps: Number(raw.maxConfBps),
    minPublishOffsetSecs: Number(raw.minPublishOffsetSecs),
    overrideDelaySecs: Number(raw.overrideDelaySecs),
    tickers,
    defaultBookCapacity: Number(raw.defaultBookCapacity),
    bump: Number(raw.bump),
  };
}

function isMockProviderVariant(v: unknown): boolean {
  if (v && typeof v === "object" && "mockPyth" in (v as Record<string, unknown>)) return true;
  return false;
}

function isOpenStateVariant(v: unknown): boolean {
  if (v && typeof v === "object" && "open" in (v as Record<string, unknown>)) return true;
  return false;
}

function outcomeFromVariant(v: unknown): "Unset" | "Yes" | "No" {
  if (v && typeof v === "object") {
    if ("yes" in (v as Record<string, unknown>)) return "Yes";
    if ("no" in (v as Record<string, unknown>)) return "No";
  }
  return "Unset";
}

function decodeMarket(raw: Record<string, unknown>): MarketAccount {
  return {
    ticker: tickerFromSymbolBytes(raw.ticker as number[]),
    strike: bnToBigint(raw.strike),
    tradingDay: Number(raw.tradingDay),
    closeTs: Number(bnToBigint(raw.closeTs)),
    state: isOpenStateVariant(raw.state) ? "Open" : "Settled",
    outcome: outcomeFromVariant(raw.outcome),
    settlementPrice: bnToBigint(raw.settlementPrice),
    settledAt: Number(bnToBigint(raw.settledAt)),
    settledByOverride: Boolean(raw.settledByOverride),
    yesMint: raw.yesMint as PublicKey,
    noMint: raw.noMint as PublicKey,
    vault: raw.vault as PublicKey,
    book: raw.book as PublicKey,
    bookCapacity: Number(raw.bookCapacity),
    pairsOutstanding: bnToBigint(raw.pairsOutstanding),
  };
}

/** Byte offset of `Market.trading_day` within the account data, after the 8-byte discriminator. */
const MARKET_TRADING_DAY_OFFSET = 8 /* disc */ + 8 /* ticker */ + 8 /* strike */;
/** Byte offset of `Market.state` within the account data. */
const MARKET_STATE_OFFSET = MARKET_TRADING_DAY_OFFSET + 4 /* trading_day */ + 8 /* close_ts */;

function u32LeBuffer(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n, 0);
  return buf;
}

/**
 * Retries `fn` up to `attempts` times with exponential backoff
 * (`baseDelayMs * 2^i`), used for the 3-retries-with-backoff-per-transaction
 * requirement on `morning`'s `create_market`/`create_book` calls. `sleepFn`
 * is injectable so tests can use fake timers.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 500,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await sleepFn(baseDelayMs * 2 ** i);
      }
    }
  }
  throw lastErr;
}

export interface ChainClientOptions {
  connection: Connection;
  adminKeypair: Keypair;
  publisherKeypair: Keypair;
  usdcMint: PublicKey;
}

/** Typed wrapper around the Anchor `Program` client for the Meridian program. */
export class ChainClient {
  readonly connection: Connection;
  readonly adminKeypair: Keypair;
  readonly publisherKeypair: Keypair;
  readonly usdcMint: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly program: any;

  constructor(opts: ChainClientOptions) {
    this.connection = opts.connection;
    this.adminKeypair = opts.adminKeypair;
    this.publisherKeypair = opts.publisherKeypair;
    this.usdcMint = opts.usdcMint;

    const wallet = new Wallet(opts.adminKeypair);
    const provider = new AnchorProvider(opts.connection, wallet, AnchorProvider.defaultOptions());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.program = new (Program as any)(IDL, provider);
  }

  async accountExists(pubkey: PublicKey): Promise<boolean> {
    const info = await this.connection.getAccountInfo(pubkey, "confirmed");
    return info !== null;
  }

  marketAddress(ticker: Ticker, tradingDay: number, strike: bigint): PublicKey {
    return marketPda(PROGRAM_ID, ticker, tradingDay, strike)[0];
  }

  private marketAccounts(ticker: Ticker, tradingDay: number, strike: bigint) {
    const [market] = marketPda(PROGRAM_ID, ticker, tradingDay, strike);
    const [yesMint] = yesMintPda(PROGRAM_ID, market);
    const [noMint] = noMintPda(PROGRAM_ID, market);
    const [vault] = vaultPda(PROGRAM_ID, market);
    const [usdcEscrow] = usdcEscrowPda(PROGRAM_ID, market);
    const [yesEscrow] = yesEscrowPda(PROGRAM_ID, market);
    const [config] = configPda(PROGRAM_ID);
    return { market, yesMint, noMint, vault, usdcEscrow, yesEscrow, config };
  }

  /** `create_market`: creates a new market for `ticker`/`tradingDay`/`strike`. */
  async createMarket(
    ticker: Ticker,
    strike: bigint,
    tradingDay: number,
    closeTs: number,
    capacity: number,
  ): Promise<PublicKey> {
    const accts = this.marketAccounts(ticker, tradingDay, strike);
    await this.program.methods
      .createMarket(Array.from(tickerSymbolBytes(ticker)), new BN(strike.toString()), tradingDay, new BN(closeTs), capacity)
      .accountsStrict({
        payer: this.adminKeypair.publicKey,
        admin: this.adminKeypair.publicKey,
        config: accts.config,
        market: accts.market,
        yesMint: accts.yesMint,
        noMint: accts.noMint,
        vault: accts.vault,
        usdcEscrow: accts.usdcEscrow,
        yesEscrow: accts.yesEscrow,
        usdcMint: this.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([this.adminKeypair])
      .rpc();
    return accts.market;
  }

  /** `add_strike`: adds a strike to an existing trading day's ladder. */
  async addStrike(
    ticker: Ticker,
    strike: bigint,
    tradingDay: number,
    closeTs: number,
    capacity: number,
  ): Promise<PublicKey> {
    const accts = this.marketAccounts(ticker, tradingDay, strike);
    await this.program.methods
      .addStrike(Array.from(tickerSymbolBytes(ticker)), new BN(strike.toString()), tradingDay, new BN(closeTs), capacity)
      .accountsStrict({
        payer: this.adminKeypair.publicKey,
        admin: this.adminKeypair.publicKey,
        config: accts.config,
        market: accts.market,
        yesMint: accts.yesMint,
        noMint: accts.noMint,
        vault: accts.vault,
        usdcEscrow: accts.usdcEscrow,
        yesEscrow: accts.yesEscrow,
        usdcMint: this.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([this.adminKeypair])
      .rpc();
    return accts.market;
  }

  /** `create_book`, repeated until `market.book` is set (see create_book.rs module doc). */
  async createBookUntilDone(market: PublicKey): Promise<void> {
    const [config] = configPda(PROGRAM_ID);
    const [book] = bookPda(PROGRAM_ID, market);

    for (let i = 0; i < 32; i += 1) {
      await this.program.methods
        .createBook()
        .accountsStrict({
          payer: this.adminKeypair.publicKey,
          admin: this.adminKeypair.publicKey,
          config,
          market,
          book,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.adminKeypair])
        .rpc();

      const marketAccount = decodeMarket(await this.program.account.market.fetch(market));
      if (marketAccount.book.toBase58() !== PublicKey.default.toBase58()) {
        return;
      }
    }
    throw new Error(`createBookUntilDone: book for market ${market.toBase58()} did not finish after 32 calls`);
  }

  /** `mock_write_price`, signed by the publisher key. Returns the `MockPriceUpdate` PDA. */
  async mockWritePrice(
    feedId: Uint8Array,
    price: bigint,
    conf: bigint,
    expo: number,
    publishTime: number,
  ): Promise<PublicKey> {
    const [config] = configPda(PROGRAM_ID);
    const [priceAccount] = mockPricePda(PROGRAM_ID, feedId);

    await this.program.methods
      .mockWritePrice(Array.from(feedId), new BN(price.toString()), new BN(conf.toString()), expo, new BN(publishTime))
      .accountsStrict({
        publisher: this.publisherKeypair.publicKey,
        config,
        price: priceAccount,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.publisherKeypair])
      .rpc();

    return priceAccount;
  }

  /** `settle_market`. Throws (possibly `isAlreadySettledError`) on failure. */
  async settleMarket(market: PublicKey, priceAccount: PublicKey): Promise<void> {
    const [config] = configPda(PROGRAM_ID);
    await this.program.methods
      .settleMarket()
      .accountsStrict({
        caller: this.adminKeypair.publicKey,
        config,
        market,
        priceAccount,
      })
      .signers([this.adminKeypair])
      .rpc();
  }

  async fetchConfig(): Promise<ConfigAccount> {
    const [config] = configPda(PROGRAM_ID);
    const raw = await this.program.account.config.fetch(config);
    return decodeConfig(raw);
  }

  async fetchMarket(market: PublicKey): Promise<MarketAccount | null> {
    const raw = await this.program.account.market.fetchNullable(market);
    return raw ? decodeMarket(raw) : null;
  }

  /**
   * All `Open` markets, optionally narrowed to one `tradingDay` via a
   * `memcmp` filter (the common case: the morning/settle jobs only ever
   * care about "today"). Always filters to `state == Open` server-side so
   * the service never has to page through settled history.
   */
  async fetchOpenMarkets(tradingDay?: number): Promise<MarketRecord[]> {
    const filters: GetProgramAccountsFilter[] = [
      {
        memcmp: {
          offset: MARKET_STATE_OFFSET,
          bytes: utils.bytes.bs58.encode(Buffer.from([0])), // MarketState::Open == 0
        },
      },
    ];
    if (tradingDay !== undefined) {
      filters.push({
        memcmp: {
          offset: MARKET_TRADING_DAY_OFFSET,
          bytes: utils.bytes.bs58.encode(u32LeBuffer(tradingDay)),
        },
      });
    }

    const records = await this.program.account.market.all(filters);
    return records.map((r: { publicKey: PublicKey; account: Record<string, unknown> }) => ({
      publicKey: r.publicKey,
      account: decodeMarket(r.account),
    }));
  }

  /**
   * All `Settled` markets, optionally narrowed to those settled at or before
   * `olderThanTs` (Unix seconds) -- used by the `reclaim` job
   * (contracts/automation.md: "`Settled` market older than 1 day"). Unlike
   * `fetchOpenMarkets`'s `tradingDay` narrowing, this can't be a server-side
   * `memcmp` filter (it's a `<=` range, not an exact byte match), so the
   * `olderThanTs` cutoff is applied client-side after the `state == Settled`
   * server-side filter narrows the set.
   */
  async fetchSettledMarkets(olderThanTs?: number): Promise<MarketRecord[]> {
    const filters: GetProgramAccountsFilter[] = [
      {
        memcmp: {
          offset: MARKET_STATE_OFFSET,
          bytes: utils.bytes.bs58.encode(Buffer.from([1])), // MarketState::Settled == 1
        },
      },
    ];

    const records = await this.program.account.market.all(filters);
    const decoded: MarketRecord[] = records.map((r: { publicKey: PublicKey; account: Record<string, unknown> }) => ({
      publicKey: r.publicKey,
      account: decodeMarket(r.account),
    }));
    if (olderThanTs === undefined) return decoded;
    return decoded.filter((m) => m.account.settledAt <= olderThanTs);
  }

  /** `close_book`: admin-only, requires `market` `Settled` with an empty book/escrows. */
  async closeBook(market: PublicKey): Promise<void> {
    await this.sendClose("closeBook", market);
  }

  /** `close_market`: admin-only, requires `close_book` already ran and the vault empty. */
  async closeMarket(market: PublicKey): Promise<void> {
    await this.sendClose("closeMarket", market);
  }

  /** Shared account list for `close_book`/`close_market` -- see `close.rs`'s `CloseAccounts`. */
  private async sendClose(method: "closeBook" | "closeMarket", market: PublicKey): Promise<void> {
    const [config] = configPda(PROGRAM_ID);
    const [book] = bookPda(PROGRAM_ID, market);
    const [usdcEscrow] = usdcEscrowPda(PROGRAM_ID, market);
    const [yesEscrow] = yesEscrowPda(PROGRAM_ID, market);
    const [vault] = vaultPda(PROGRAM_ID, market);
    const [yesMint] = yesMintPda(PROGRAM_ID, market);
    const [noMint] = noMintPda(PROGRAM_ID, market);

    await this.program.methods[method]()
      .accountsStrict({
        admin: this.adminKeypair.publicKey,
        config,
        market,
        book,
        usdcEscrow,
        yesEscrow,
        vault,
        yesMint,
        noMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.adminKeypair])
      .rpc();
  }

  /**
   * Reads and decodes the raw Book account's header at `book` (bid/ask
   * counts, needed by `reclaim` to decide whether `close_book` is safe to
   * call). Returns `null` if the account doesn't exist (already closed).
   */
  async fetchBookHeader(book: PublicKey): Promise<BookHeader | null> {
    const info = await this.connection.getAccountInfo(book, "confirmed");
    if (!info) return null;
    return decodeBook(info.data).header;
  }

  /**
   * An SPL token account's raw base-unit balance, or `0n` if the account is
   * positively absent (already closed). Used by `reclaim` to check
   * escrow/vault emptiness before calling `close_book`/`close_market`.
   *
   * Fix #23: `0n` is only ever returned when `getAccountInfo` confirms the
   * account doesn't exist. Any other failure (RPC timeout, rate limit,
   * transient network error) is rethrown rather than swallowed -- silently
   * treating "the read failed" the same as "the account is empty" would let
   * `reclaim` wrongly `close_book`/`close_market` a market whose escrow or
   * vault actually still holds funds. The caller (`reclaimOneMarket`) is
   * expected to catch this per-market and skip with a logged reason.
   */
  async getTokenAccountBalance(pubkey: PublicKey): Promise<bigint> {
    const info = await this.connection.getAccountInfo(pubkey, "confirmed");
    if (info === null) return 0n;
    const res = await this.connection.getTokenAccountBalance(pubkey, "confirmed");
    return BigInt(res.value.amount);
  }
}

/** Reads a program's raw IDL JSON off disk, for diagnostics only (not used on the hot path). */
export function readIdlFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
