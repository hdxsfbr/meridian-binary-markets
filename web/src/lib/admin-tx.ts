/**
 * Instruction builders and a self-contained send helper for `/admin` (T074):
 * `pause`, `unpause`, `addStrike` (picks `create_market` vs `add_strike` plus
 * the `create_book` loop), `adminSettleOverride`, and a partial
 * `updateConfig`. Mirrors the Anchor `methods` builder pattern used
 * elsewhere in `web/src/lib` (account lists copied from
 * `packages/sdk/src/idl.ts`), but is otherwise independent: this file does
 * not import from `web/src/lib/tx.ts` (another agent's trade-panel
 * builders), and ships its own `sendTx`/error-mapping so this page never
 * depends on that file's internals.
 */

import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  type Connection,
  type TransactionSignature,
} from "@solana/web3.js";
import { BN, type Program } from "@anchor-lang/core";
import {
  bookPda,
  configPda,
  marketPda,
  noMintPda,
  tickerSymbolBytes,
  usdcEscrowPda,
  vaultPda,
  yesEscrowPda,
  yesMintPda,
  type Ticker,
} from "@meridian/sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./ata";
import { fetchYesNoTokenProgram, isWalletRejection } from "./tx";
import { PROGRAM_ID } from "./rpc";
import { validateNewStrike } from "./admin-view";

export type TxResult = { ok: true; signature: TransactionSignature } | { ok: false; error: string };

/** Minimal shape of an Anchor `methods` builder this file needs (same narrowing approach as `useProgram.ts`'s `accountClient`). */
type MethodsBuilderLike = {
  accountsPartial(accounts: Record<string, PublicKey | null>): MethodsBuilderLike;
  instruction(): Promise<import("@solana/web3.js").TransactionInstruction>;
};

function methodCall(program: Program, name: string, args: unknown[]): MethodsBuilderLike {
  const methods = program.methods as unknown as Record<string, (...a: unknown[]) => MethodsBuilderLike>;
  return methods[name](...args);
}

function bn(value: bigint | number): BN {
  return new BN(value.toString());
}

/** Fetches `Market.book` directly (not `create_book`'s own account, which may not exist yet). */
async function fetchMarketBookField(program: Program, market: PublicKey): Promise<PublicKey> {
  const raw = (await (
    program.account as unknown as Record<string, { fetch(a: PublicKey): Promise<unknown> }>
  ).market.fetch(market)) as { book: PublicKey };
  return new PublicKey(raw.book);
}

/**
 * Sends one or more instructions as a single transaction and waits for
 * confirmation. `sendTransaction` matches
 * `@solana/wallet-adapter-react`'s `useWallet().sendTransaction` shape.
 * Never throws: failures are returned as `{ ok: false, error }` with
 * `error` already mapped to plain-language copy.
 */
export async function sendTx(
  connection: Connection,
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<TransactionSignature>,
  ixs: Array<import("@solana/web3.js").TransactionInstruction>,
  feePayer: PublicKey,
): Promise<TxResult> {
  try {
    const tx = new Transaction();
    tx.add(...ixs);
    tx.feePayer = feePayer;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const signature = await sendTransaction(tx, connection);
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (confirmation.value.err) {
      // Landed but failed on-chain: never report success (item 9).
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }
    return { ok: true, signature };
  } catch (error) {
    console.error("[meridian] admin transaction failed", error);
    return { ok: false, error: describeError(error) };
  }
}

/** Known on-chain error names this page can explain in plain language. */
const KNOWN_ERRORS: Record<string, string> = {
  Unauthorized: "Only the operator wallet can do this.",
  OverrideTooEarly: "The override delay has not elapsed yet.",
  AlreadySettled: "This market is already settled.",
  OracleBadPrice: "Enter a price greater than zero.",
  InvariantViolated: "That configuration or market change is not allowed.",
};

function extractErrorName(error: unknown): string | undefined {
  if (error !== null && typeof error === "object") {
    const anchorError = error as { error?: { errorCode?: { code?: string } } };
    const code = anchorError.error?.errorCode?.code;
    if (typeof code === "string") {
      return code;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      for (const name of Object.keys(KNOWN_ERRORS)) {
        if (message.includes(name)) {
          return name;
        }
      }
    }
  }
  return undefined;
}

/** Maps a failed send/simulate error to plain-language copy; never a raw program error code. */
export function describeError(error: unknown): string {
  if (isWalletRejection(error)) {
    return "Signing was cancelled in your wallet.";
  }
  const name = extractErrorName(error);
  if (name && KNOWN_ERRORS[name]) {
    return KNOWN_ERRORS[name];
  }
  return "That action did not go through. Try again.";
}

export type SendFn = (tx: Transaction, connection: Connection) => Promise<TransactionSignature>;

/** `pause()`: blocks mint and order placement, never redemption (FR-034). */
export async function pause(program: Program, connection: Connection, sendTransaction: SendFn, admin: PublicKey): Promise<TxResult> {
  const ix = await methodCall(program, "pause", [])
    .accountsPartial({ admin, config: configPda(PROGRAM_ID)[0] })
    .instruction();
  return sendTx(connection, sendTransaction, [ix], admin);
}

/** `unpause()`. */
export async function unpause(program: Program, connection: Connection, sendTransaction: SendFn, admin: PublicKey): Promise<TxResult> {
  const ix = await methodCall(program, "unpause", [])
    .accountsPartial({ admin, config: configPda(PROGRAM_ID)[0] })
    .instruction();
  return sendTx(connection, sendTransaction, [ix], admin);
}

export type AddStrikeArgs = {
  ticker: Ticker;
  /** Micro-USD (already converted from the dollar input). */
  strike: bigint;
  tradingDay: number;
  closeTs: number;
  capacity: number;
};

/**
 * `create_market`/`add_strike` always create Token-2022 Yes/No mints (every
 * market created from the Token-2022 migration on -- there is no "classic
 * mode" left in that instruction; see `create_market.rs`'s module doc).
 * `tokenProgram` is hardcoded to Token-2022 here for that reason, not
 * resolved from chain -- there is nothing to resolve yet, the mints don't
 * exist until this instruction creates them. `usdcTokenProgram` stays
 * classic SPL Token (USDC is unaffected by this migration).
 */
function marketCreationAccounts(market: PublicKey, admin: PublicKey, usdcMint: PublicKey) {
  return {
    payer: admin,
    admin,
    config: configPda(PROGRAM_ID)[0],
    market,
    yesMint: yesMintPda(PROGRAM_ID, market)[0],
    noMint: noMintPda(PROGRAM_ID, market)[0],
    vault: vaultPda(PROGRAM_ID, market)[0],
    usdcEscrow: usdcEscrowPda(PROGRAM_ID, market)[0],
    yesEscrow: yesEscrowPda(PROGRAM_ID, market)[0],
    usdcMint,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    usdcTokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  };
}

/**
 * Adds a strike: `create_market` if this is the first strike for
 * `ticker`/`tradingDay` (`isFirstForTicker`), otherwise `add_strike` — both
 * share one account shape. Then loops `create_book` (one call per
 * transaction) until `Market.book` is set, mirroring
 * `services/automation/src/chain.ts`'s `createBookUntilDone`.
 */
export async function addStrike(
  program: Program,
  connection: Connection,
  sendTransaction: SendFn,
  admin: PublicKey,
  usdcMint: PublicKey,
  args: AddStrikeArgs,
  isFirstForTicker: boolean,
): Promise<TxResult> {
  const [market] = marketPda(PROGRAM_ID, args.ticker, args.tradingDay, args.strike);
  const accounts = marketCreationAccounts(market, admin, usdcMint);
  const methodName = isFirstForTicker ? "createMarket" : "addStrike";
  const ix = await methodCall(program, methodName, [
    Array.from(tickerSymbolBytes(args.ticker)),
    bn(args.strike),
    args.tradingDay,
    bn(args.closeTs),
    args.capacity,
  ])
    .accountsPartial(accounts)
    .instruction();

  const first = await sendTx(connection, sendTransaction, [ix], admin);
  if (!first.ok) {
    return first;
  }

  // `create_book` is split out of `create_market`/`add_strike` (see
  // `create_book.rs`'s module doc); loop until `Market.book` (re-fetched
  // after every call, not just "does the Book account exist") equals the
  // expected PDA (item 10). Max 8 attempts; throws if that's not enough --
  // this function never silently reports success on an incomplete book.
  const [book] = bookPda(PROGRAM_ID, market);
  let lastResult: TxResult = first;
  const MAX_CREATE_BOOK_ATTEMPTS = 8;
  for (let i = 0; i < MAX_CREATE_BOOK_ATTEMPTS; i += 1) {
    const currentBook = await fetchMarketBookField(program, market);
    if (currentBook.equals(book)) {
      return lastResult;
    }
    const bookIx = await methodCall(program, "createBook", [])
      .accountsPartial({
        payer: admin,
        admin,
        config: configPda(PROGRAM_ID)[0],
        market,
        book,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    lastResult = await sendTx(connection, sendTransaction, [bookIx], admin);
    if (!lastResult.ok) {
      return lastResult;
    }
  }
  const finalBook = await fetchMarketBookField(program, market);
  if (!finalBook.equals(book)) {
    throw new Error(`addStrike: create_book did not complete after ${MAX_CREATE_BOOK_ATTEMPTS} attempts`);
  }
  return lastResult;
}

export type RemoveStrikeArgs = {
  ticker: Ticker;
  strike: bigint;
  tradingDay: number;
};

/**
 * `remove_strike()`: admin-only, same account shape as `close_market` (both
 * instructions close the market/book/escrows/vault/mints and return rent to
 * the admin). The program only lets this succeed when the market is still
 * `Open` with zero pairs outstanding, an empty book, and empty
 * escrows/vault -- this function does not re-check those conditions itself
 * (`admin-view.ts`'s `strikeAdjustability` is what the page uses to decide
 * whether to even offer the button); it just builds and sends the one
 * instruction and lets the program reject otherwise.
 */
export async function removeStrike(
  program: Program,
  connection: Connection,
  sendTransaction: SendFn,
  admin: PublicKey,
  args: RemoveStrikeArgs,
): Promise<TxResult> {
  const [market] = marketPda(PROGRAM_ID, args.ticker, args.tradingDay, args.strike);
  const yesNoTokenProgram = await fetchYesNoTokenProgram(program, market);
  const ix = await methodCall(program, "removeStrike", [])
    .accountsPartial({
      admin,
      config: configPda(PROGRAM_ID)[0],
      market,
      book: bookPda(PROGRAM_ID, market)[0],
      usdcEscrow: usdcEscrowPda(PROGRAM_ID, market)[0],
      yesEscrow: yesEscrowPda(PROGRAM_ID, market)[0],
      vault: vaultPda(PROGRAM_ID, market)[0],
      yesMint: yesMintPda(PROGRAM_ID, market)[0],
      noMint: noMintPda(PROGRAM_ID, market)[0],
      usdcTokenProgram: TOKEN_PROGRAM_ID,
      yesnoTokenProgram: yesNoTokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return sendTx(connection, sendTransaction, [ix], admin);
}

/** Which stage of `adjustStrike`'s two-signature flow is in progress. */
export type AdjustStrikeStage = "removing" | "creating";

/**
 * `adjustStrike`'s result carries which stage finished, so a caller whose
 * create step fails (wallet rejection, or `create_book` never completing)
 * knows the old strike is already gone and must not retry removal -- its
 * accounts no longer exist, so a second `removeStrike` would just fail.
 * `removed: true` is the signal to show "Removed $X. Creating $Y did not
 * finish." and offer a resume control that calls `addStrike` alone (never
 * `adjustStrike` again, which would re-run `removeStrike`).
 */
export type AdjustStrikeResult =
  | { ok: true; signature: TransactionSignature }
  | { ok: false; error: string; removed: false }
  | { ok: false; error: string; removed: true };

/**
 * "Adjust" a strike = `removeStrike` the old one, then `addStrike` the new
 * one (two signatures; FR-10's "add or adjust strikes"). Stops and returns
 * `removed: false` as soon as the removal itself fails -- it never attempts
 * to create the new strike on top of a strike that is still live. If
 * removal succeeds but the create step fails or never finishes, the result
 * carries `removed: true` so the caller can offer to resume just that step
 * (see `AdjustStrikeResult`). `onProgress` is called once per stage, before
 * that stage's transaction is sent, so the caller can show "Removing
 * $X..." / "Creating $Y..." without this function knowing anything about
 * dollar formatting.
 *
 * Re-validates `newStrike.strike` with `validateNewStrike` (bounds only --
 * no `existingStrikes` context here) before sending anything: the admin
 * page already validates before calling this, but an out-of-range value
 * (e.g. above the on-chain `u64` ceiling) must never reach `removeStrike`,
 * so this is checked again as the actual gate, not just trusted from the
 * caller.
 */
export async function adjustStrike(
  program: Program,
  connection: Connection,
  sendTransaction: SendFn,
  admin: PublicKey,
  usdcMint: PublicKey,
  oldStrike: RemoveStrikeArgs,
  newStrike: AddStrikeArgs,
  isFirstForTicker: boolean,
  onProgress?: (stage: AdjustStrikeStage) => void,
): Promise<AdjustStrikeResult> {
  const validationError = validateNewStrike(newStrike.strike, []);
  if (validationError !== null) {
    return { ok: false, error: validationError, removed: false };
  }

  onProgress?.("removing");
  const removed = await removeStrike(program, connection, sendTransaction, admin, oldStrike);
  if (!removed.ok) {
    return { ok: false, error: removed.error, removed: false };
  }
  onProgress?.("creating");
  const created = await addStrike(program, connection, sendTransaction, admin, usdcMint, newStrike, isFirstForTicker);
  if (!created.ok) {
    return { ok: false, error: created.error, removed: true };
  }
  return created;
}

/** `admin_settle_override(price)`: the escape hatch when the automated settle job never fires. */
export async function adminSettleOverride(
  program: Program,
  connection: Connection,
  sendTransaction: SendFn,
  admin: PublicKey,
  market: PublicKey,
  priceMicro: bigint,
): Promise<TxResult> {
  const ix = await methodCall(program, "adminSettleOverride", [bn(priceMicro)])
    .accountsPartial({ admin, config: configPda(PROGRAM_ID)[0], market })
    .instruction();
  return sendTx(connection, sendTransaction, [ix], admin);
}

/** Partial `update_config` args; every field optional, mirroring the on-chain `UpdateConfigArgs`. */
export type UpdateConfigPartial = {
  overrideDelaySecs?: number;
  maxStalenessSecs?: number;
  maxConfBps?: number;
  minPublishOffsetSecs?: number;
  defaultBookCapacity?: number;
};

/** `update_config`: only the provided fields are applied (every other field sent as `null`/unchanged). */
export async function updateConfig(
  program: Program,
  connection: Connection,
  sendTransaction: SendFn,
  admin: PublicKey,
  partial: UpdateConfigPartial,
): Promise<TxResult> {
  const args = {
    oracleProvider: null,
    oracleProgram: null,
    publishers: null,
    maxStalenessSecs: partial.maxStalenessSecs ?? null,
    maxConfBps: partial.maxConfBps ?? null,
    minPublishOffsetSecs: partial.minPublishOffsetSecs ?? null,
    overrideDelaySecs: partial.overrideDelaySecs ?? null,
    tickers: null,
    defaultBookCapacity: partial.defaultBookCapacity ?? null,
  };
  const ix = await methodCall(program, "updateConfig", [args])
    .accountsPartial({ admin, config: configPda(PROGRAM_ID)[0] })
    .instruction();
  return sendTx(connection, sendTransaction, [ix], admin);
}
