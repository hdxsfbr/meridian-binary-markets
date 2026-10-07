/**
 * `reclaim` job (contracts/automation.md, tasks.md T083/T081): for every
 * `Settled` market older than one day (`settled_at <= now - 24h`), closes
 * its book (if not already closed) and then its market, reclaiming rent to
 * the admin -- best effort, per-market try/catch, one summary log line at
 * the end (contracts/automation.md: "`reclaim` | 20:00 | ... | best effort,
 * logged").
 *
 * Each market is independent and gated by two empty checks, mirroring
 * `programs/meridian/src/instructions/close.rs`'s own guards so this job's
 * skip reasons read the same as the on-chain error they'd otherwise hit:
 *   - `close_book` needs the book's `bidCount`/`askCount` both zero and both
 *     of its escrow token accounts empty.
 *   - `close_market` needs `close_book` to have already run (witnessed by
 *     `market.book == Pubkey.default()`) and the vault empty.
 * A market that fails either check is logged and skipped, not retried --
 * the next day's run will pick it up once whatever is blocking it (a
 * resting order, an unredeemed winner) is gone.
 */

import { PublicKey } from "@solana/web3.js";
import { usdcEscrowPda, vaultPda, yesEscrowPda, PROGRAM_ID } from "@meridian/sdk";
import type { BookHeader, Ticker } from "@meridian/sdk";
import type { MarketRecord } from "../chain.js";
import { log } from "../log.js";

/** `reclaim` only considers markets settled at least this long ago, unless `--all-settled`. */
export const RECLAIM_MIN_AGE_SECONDS = 24 * 60 * 60;

export interface ReclaimChain {
  fetchSettledMarkets(olderThanTs?: number): Promise<MarketRecord[]>;
  fetchBookHeader(book: PublicKey): Promise<BookHeader | null>;
  getTokenAccountBalance(pubkey: PublicKey): Promise<bigint>;
  closeBook(market: PublicKey): Promise<void>;
  closeMarket(market: PublicKey): Promise<void>;
}

export interface ReclaimJobDeps {
  chain: ReclaimChain;
  now?: () => number;
}

export interface ReclaimJobOptions {
  /** Narrows to one `tradingDay` (`YYYYMMDD`), for testing/demo scoping. */
  day?: number;
  /** Bypasses the 24h age cutoff: considers every `Settled` market regardless of age. */
  allSettled?: boolean;
  /** Logs what would happen without sending any `close_book`/`close_market` transaction. */
  dryRun?: boolean;
}

interface ReclaimSummary {
  marketsConsidered: number;
  booksClosed: number;
  marketsClosed: number;
  skipped: number;
  failed: number;
}

/** Whether a Book is empty enough for `close_book`: zero resting orders on both sides. */
function bookIsEmpty(header: BookHeader): boolean {
  return header.bidCount === 0 && header.askCount === 0;
}

/**
 * Handles one market: closes its book (if needed and empty) then its market
 * (if the book is closed and the vault is empty). Never throws -- every
 * branch that can't proceed logs a skip reason and returns instead.
 */
async function reclaimOneMarket(
  chain: ReclaimChain,
  record: MarketRecord,
  dryRun: boolean,
  summary: ReclaimSummary,
): Promise<void> {
  const market = record.publicKey;
  const key = market.toBase58();
  const ticker: Ticker = record.account.ticker;

  let bookClosed = record.account.book.equals(PublicKey.default);

  if (!bookClosed) {
    const header = await chain.fetchBookHeader(record.account.book);
    if (header === null) {
      // The Book account is already gone on chain even though `market.book`
      // hadn't been reset when we read the market -- treat as closed rather
      // than erroring; `close_market`'s own guard is what actually matters.
      bookClosed = true;
    } else if (!bookIsEmpty(header)) {
      summary.skipped += 1;
      log({
        job: "reclaim",
        ticker,
        market: key,
        step: "close_book",
        ok: false,
        error: `skipped: book not empty (bidCount=${header.bidCount}, askCount=${header.askCount})`,
      });
    } else {
      const [usdcEscrow] = usdcEscrowPda(PROGRAM_ID, market);
      const [yesEscrow] = yesEscrowPda(PROGRAM_ID, market);
      const [usdcBalance, yesBalance] = await Promise.all([
        chain.getTokenAccountBalance(usdcEscrow),
        chain.getTokenAccountBalance(yesEscrow),
      ]);

      if (usdcBalance !== 0n || yesBalance !== 0n) {
        summary.skipped += 1;
        log({
          job: "reclaim",
          ticker,
          market: key,
          step: "close_book",
          ok: false,
          error: `skipped: escrow not empty (usdc=${usdcBalance}, yes=${yesBalance})`,
        });
      } else if (dryRun) {
        log({ job: "reclaim", ticker, market: key, step: "close_book", ok: true, error: "dry-run: would close" });
        bookClosed = true;
      } else {
        await chain.closeBook(market);
        summary.booksClosed += 1;
        bookClosed = true;
        log({ job: "reclaim", ticker, market: key, step: "close_book", ok: true });
      }
    }
  }

  if (!bookClosed) {
    // `close_book` didn't run this pass (skipped above or failed) -- `close_market`
    // would fail its own `NotEmpty` guard, so don't even attempt it.
    return;
  }

  const [vault] = vaultPda(PROGRAM_ID, market);
  const vaultBalance = await chain.getTokenAccountBalance(vault);
  if (vaultBalance !== 0n) {
    summary.skipped += 1;
    log({
      job: "reclaim",
      ticker,
      market: key,
      step: "close_market",
      ok: false,
      error: `skipped: vault not empty (${vaultBalance})`,
    });
    return;
  }

  if (dryRun) {
    log({ job: "reclaim", ticker, market: key, step: "close_market", ok: true, error: "dry-run: would close" });
    return;
  }

  await chain.closeMarket(market);
  summary.marketsClosed += 1;
  log({ job: "reclaim", ticker, market: key, step: "close_market", ok: true });
}

/** Runs one pass of the reclaim job: discover, then best-effort close each eligible market. */
export async function runReclaimJob(deps: ReclaimJobDeps, opts: ReclaimJobOptions = {}): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const dryRun = opts.dryRun ?? false;
  const nowSeconds = Math.floor(now() / 1000);
  const olderThanTs = opts.allSettled ? undefined : nowSeconds - RECLAIM_MIN_AGE_SECONDS;

  const settled = await deps.chain.fetchSettledMarkets(olderThanTs);
  const scoped = opts.day === undefined ? settled : settled.filter((m) => m.account.tradingDay === opts.day);

  const summary: ReclaimSummary = {
    marketsConsidered: scoped.length,
    booksClosed: 0,
    marketsClosed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const record of scoped) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await reclaimOneMarket(deps.chain, record, dryRun, summary);
    } catch (err) {
      summary.failed += 1;
      const message = (err as Error).message ?? String(err);
      log({
        job: "reclaim",
        ticker: record.account.ticker,
        market: record.publicKey.toBase58(),
        step: "reclaim_market",
        ok: false,
        error: message,
      });
    }
  }

  log({
    job: "reclaim",
    step: "summary",
    ok: summary.failed === 0,
    error:
      `considered=${summary.marketsConsidered} booksClosed=${summary.booksClosed} ` +
      `marketsClosed=${summary.marketsClosed} skipped=${summary.skipped} failed=${summary.failed}` +
      (dryRun ? " (dry-run)" : ""),
  });
}
