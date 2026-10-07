/**
 * Instruction builders for the trade panel (T064) and portfolio actions this
 * wave owns (mint/redeem pair). Each builder takes a `BuildCtx` (the Anchor
 * program client plus the signer and market pubkeys) and the instruction's
 * own arguments, and returns a `TransactionInstruction` built via the Anchor
 * `methods` API — nothing here sends anything.
 *
 * Account lists mirror `packages/sdk/src/idl.ts` exactly for `place_order`,
 * `cancel_order`, `mint_pair`, and `redeem_pair`. `buy_no_market`,
 * `buy_no_limit`, and `sell_no_market` are still stubs on `main` (only a
 * `user` signer) pending agent A's Wave 5 work on the program side; this
 * file codes their account lists against the FULL set described in the
 * Wave 5C brief — `user, config, market, yes_mint, no_mint, vault, book,
 * usdc_escrow, yes_escrow, user_usdc, user_yes, user_no, token_program,
 * associated_token_program, system_program` — which is also research.md
 * R8's composition (mint pair + take/rest the Yes leg) and will match once
 * the IDL is regenerated.
 *
 * `remaining_accounts` convention (program's `place_order.rs`,
 * `escrow::validate_maker_account`): a bid taker's makers are validated
 * against `config.usdc_mint` (they receive USDC), an ask taker's makers
 * against `market.yes_mint` (they receive Yes). `buy_no_market` internally
 * sells Yes IOC into bids (ask-shaped: maker accounts are bid makers' Yes
 * accounts) and `sell_no_market` internally buys Yes IOC from asks
 * (bid-shaped: maker accounts are ask makers' USDC accounts).
 */

import {
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  type TransactionInstruction,
  type TransactionSignature,
} from "@solana/web3.js";
import { BN, type Program } from "@anchor-lang/core";
import { bookPda, configPda, noMintPda, usdcEscrowPda, vaultPda, yesEscrowPda, yesMintPda } from "@meridian/sdk";
import type { InstructionPlan } from "@meridian/sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, associatedTokenAddress } from "./ata";
import { PROGRAM_ID } from "./rpc";
import { programErrorCopy } from "./trade-copy";

/** The program's hard cap on fills per instruction (mirrors `#book`'s `MAX_FILLS`). */
const MAX_FILLS = 8;

export type BuildCtx = {
  program: Program;
  user: PublicKey;
  market: PublicKey;
  /** `Config.usdc_mint`; callers get this once via `fetchUsdcMint`. */
  usdcMint: PublicKey;
};

/** PDAs derived from `market` alone, shared by every builder in this file. */
function marketAccounts(market: PublicKey) {
  return {
    config: configPda(PROGRAM_ID)[0],
    book: bookPda(PROGRAM_ID, market)[0],
    usdcEscrow: usdcEscrowPda(PROGRAM_ID, market)[0],
    yesEscrow: yesEscrowPda(PROGRAM_ID, market)[0],
    vault: vaultPda(PROGRAM_ID, market)[0],
    yesMint: yesMintPda(PROGRAM_ID, market)[0],
    noMint: noMintPda(PROGRAM_ID, market)[0],
  };
}

function userTokenAccounts(user: PublicKey, usdcMint: PublicKey, yesMint: PublicKey, noMint: PublicKey) {
  return {
    userUsdc: associatedTokenAddress(user, usdcMint),
    userYes: associatedTokenAddress(user, yesMint),
    userNo: associatedTokenAddress(user, noMint),
  };
}

/**
 * Which mint the maker's remaining-account must be, for each taker shape.
 * `bidTaker`/`sellNoMarket` takers buy Yes, so their makers are paid in
 * USDC; `askTaker`/`buyNoMarket` takers sell Yes, so their makers are paid
 * in Yes.
 */
export type MakerSide = "bidTaker" | "askTaker" | "buyNoMarket" | "sellNoMarket";

/**
 * Derives the `remaining_accounts` list of maker token ATAs for a planned
 * set of fills, capped at the program's `MAX_FILLS`. Pure (no RPC calls):
 * `mints.usdc`/`mints.yes` are PDAs the caller already has.
 */
export function makerAccountsFor(
  makers: PublicKey[],
  side: MakerSide,
  mints: { usdc: PublicKey; yes: PublicKey },
): PublicKey[] {
  const mint = side === "bidTaker" || side === "sellNoMarket" ? mints.usdc : mints.yes;
  return makers.slice(0, MAX_FILLS).map((maker) => associatedTokenAddress(maker, mint));
}

function remainingAccountMetas(pubkeys: PublicKey[]) {
  return pubkeys.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }));
}

/** Minimal shape of an Anchor `methods` builder; narrows the generic `Program<Idl>` the same way `useProgram.ts`'s `accountClient` narrows `.account`. */
type MethodsBuilderLike = {
  accountsPartial(accounts: Record<string, PublicKey | null>): MethodsBuilderLike;
  remainingAccounts(accounts: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }>): MethodsBuilderLike;
  instruction(): Promise<TransactionInstruction>;
};

function methodCall(program: Program, name: string, args: unknown[]): MethodsBuilderLike {
  const methods = program.methods as unknown as Record<string, (...a: unknown[]) => MethodsBuilderLike>;
  return methods[name](...args);
}

function bn(value: bigint): BN {
  return new BN(value.toString());
}

/** `Config.usdc_mint`, fetched fresh (not cached) so a config change never serves a stale mint. */
export async function fetchUsdcMint(program: Program): Promise<PublicKey> {
  const [pda] = configPda(PROGRAM_ID);
  const account = (await (program.account as unknown as Record<string, { fetch(a: PublicKey): Promise<unknown> }>).config.fetch(
    pda,
  )) as { usdcMint: PublicKey };
  return new PublicKey(account.usdcMint);
}

export type PlaceOrderArgs = {
  side: 0 | 1;
  price: bigint;
  qty: bigint;
  tif: 0 | 1;
  makers: PublicKey[];
};

/** Buy Yes / Sell Yes (market or limit): `place_order(side, price, qty, tif)`. */
export async function placeOrder(ctx: BuildCtx, args: PlaceOrderArgs): Promise<TransactionInstruction> {
  const accs = marketAccounts(ctx.market);
  const { userUsdc, userYes } = userTokenAccounts(ctx.user, ctx.usdcMint, accs.yesMint, accs.noMint);
  const makerSide: MakerSide = args.side === 0 ? "bidTaker" : "askTaker";
  const makerAtas = makerAccountsFor(args.makers, makerSide, { usdc: ctx.usdcMint, yes: accs.yesMint });

  return methodCall(ctx.program, "placeOrder", [args.side, bn(args.price), bn(args.qty), args.tif])
    .accountsPartial({
      user: ctx.user,
      config: accs.config,
      market: ctx.market,
      book: accs.book,
      usdcEscrow: accs.usdcEscrow,
      yesEscrow: accs.yesEscrow,
      userUsdc,
      yesMint: accs.yesMint,
      userYes,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccountMetas(makerAtas))
    .instruction();
}

export type CancelOrderArgs = { orderId: bigint };

/** Cancels a resting order: `cancel_order(order_id)`. */
export async function cancelOrder(ctx: BuildCtx, args: CancelOrderArgs): Promise<TransactionInstruction> {
  const accs = marketAccounts(ctx.market);
  const { userUsdc, userYes } = userTokenAccounts(ctx.user, ctx.usdcMint, accs.yesMint, accs.noMint);

  return methodCall(ctx.program, "cancelOrder", [bn(args.orderId)])
    .accountsPartial({
      owner: ctx.user,
      market: ctx.market,
      book: accs.book,
      usdcEscrow: accs.usdcEscrow,
      yesEscrow: accs.yesEscrow,
      userUsdc,
      userYes,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export type MintPairArgs = { qty: bigint };

/** Mints `qty` Yes + `qty` No for `qty` USDC: `mint_pair(qty)`. */
export async function mintPair(ctx: BuildCtx, args: MintPairArgs): Promise<TransactionInstruction> {
  const accs = marketAccounts(ctx.market);
  const { userUsdc, userYes, userNo } = userTokenAccounts(ctx.user, ctx.usdcMint, accs.yesMint, accs.noMint);

  return methodCall(ctx.program, "mintPair", [bn(args.qty)])
    .accountsPartial({
      user: ctx.user,
      config: accs.config,
      market: ctx.market,
      yesMint: accs.yesMint,
      noMint: accs.noMint,
      vault: accs.vault,
      userUsdc,
      userYes,
      userNo,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export type RedeemPairArgs = { qty: bigint };

/** Redeems `qty` matched Yes + No pairs for `qty` USDC: `redeem_pair(qty)`. */
export async function redeemPair(ctx: BuildCtx, args: RedeemPairArgs): Promise<TransactionInstruction> {
  const accs = marketAccounts(ctx.market);
  const { userUsdc, userYes, userNo } = userTokenAccounts(ctx.user, ctx.usdcMint, accs.yesMint, accs.noMint);

  return methodCall(ctx.program, "redeemPair", [bn(args.qty)])
    .accountsPartial({
      user: ctx.user,
      config: accs.config,
      market: ctx.market,
      yesMint: accs.yesMint,
      noMint: accs.noMint,
      vault: accs.vault,
      userUsdc,
      userYes,
      userNo,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * Full account list the three composite No instructions below are coded
 * against (see module doc): everything `mint_pair` needs (to mint the
 * pair) plus everything `place_order` needs (to take/rest the Yes leg).
 */
function noCompositeAccounts(ctx: BuildCtx) {
  const accs = marketAccounts(ctx.market);
  const tokens = userTokenAccounts(ctx.user, ctx.usdcMint, accs.yesMint, accs.noMint);
  return {
    user: ctx.user,
    config: accs.config,
    market: ctx.market,
    yesMint: accs.yesMint,
    noMint: accs.noMint,
    vault: accs.vault,
    book: accs.book,
    usdcEscrow: accs.usdcEscrow,
    yesEscrow: accs.yesEscrow,
    userUsdc: tokens.userUsdc,
    userYes: tokens.userYes,
    userNo: tokens.userNo,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

export type BuyNoMarketArgs = { qty: bigint; minYesPrice: bigint; makers: PublicKey[] };

/** Buy No (market): mints `qty` pairs, sells Yes IOC into bids, redeems any unfilled pair (R8). */
export async function buyNoMarket(ctx: BuildCtx, args: BuyNoMarketArgs): Promise<TransactionInstruction> {
  const accounts = noCompositeAccounts(ctx);
  const makerAtas = makerAccountsFor(args.makers, "buyNoMarket", { usdc: ctx.usdcMint, yes: accounts.yesMint });

  return methodCall(ctx.program, "buyNoMarket", [bn(args.qty), bn(args.minYesPrice)])
    .accountsPartial({
      user: accounts.user,
      config: accounts.config,
      market: accounts.market,
      yesMint: accounts.yesMint,
      noMint: accounts.noMint,
      vault: accounts.vault,
      book: accounts.book,
      usdcEscrow: accounts.usdcEscrow,
      yesEscrow: accounts.yesEscrow,
      userUsdc: accounts.userUsdc,
      userYes: accounts.userYes,
      userNo: accounts.userNo,
      tokenProgram: accounts.tokenProgram,
      associatedTokenProgram: accounts.associatedTokenProgram,
      systemProgram: accounts.systemProgram,
    })
    .remainingAccounts(remainingAccountMetas(makerAtas))
    .instruction();
}

export type BuyNoLimitArgs = { qty: bigint; price: bigint };

/** Buy No (limit): mints `qty` pairs, posts a Yes ask at `price`; user holds both until it fills (FR-014). */
export async function buyNoLimit(ctx: BuildCtx, args: BuyNoLimitArgs): Promise<TransactionInstruction> {
  const accounts = noCompositeAccounts(ctx);

  return methodCall(ctx.program, "buyNoLimit", [bn(args.qty), bn(args.price)])
    .accountsPartial({
      user: accounts.user,
      config: accounts.config,
      market: accounts.market,
      yesMint: accounts.yesMint,
      noMint: accounts.noMint,
      vault: accounts.vault,
      book: accounts.book,
      usdcEscrow: accounts.usdcEscrow,
      yesEscrow: accounts.yesEscrow,
      userUsdc: accounts.userUsdc,
      userYes: accounts.userYes,
      userNo: accounts.userNo,
      tokenProgram: accounts.tokenProgram,
      associatedTokenProgram: accounts.associatedTokenProgram,
      systemProgram: accounts.systemProgram,
    })
    .instruction();
}

export type SellNoMarketArgs = { qty: bigint; maxYesPrice: bigint; makers: PublicKey[] };

/** Sell No (market): buys Yes IOC from asks, redeems the resulting pairs, user receives `qty * (1 - p)` (R8). */
export async function sellNoMarket(ctx: BuildCtx, args: SellNoMarketArgs): Promise<TransactionInstruction> {
  const accounts = noCompositeAccounts(ctx);
  const makerAtas = makerAccountsFor(args.makers, "sellNoMarket", { usdc: ctx.usdcMint, yes: accounts.yesMint });

  return methodCall(ctx.program, "sellNoMarket", [bn(args.qty), bn(args.maxYesPrice)])
    .accountsPartial({
      user: accounts.user,
      config: accounts.config,
      market: accounts.market,
      yesMint: accounts.yesMint,
      noMint: accounts.noMint,
      vault: accounts.vault,
      book: accounts.book,
      usdcEscrow: accounts.usdcEscrow,
      yesEscrow: accounts.yesEscrow,
      userUsdc: accounts.userUsdc,
      userYes: accounts.userYes,
      userNo: accounts.userNo,
      tokenProgram: accounts.tokenProgram,
      associatedTokenProgram: accounts.associatedTokenProgram,
      systemProgram: accounts.systemProgram,
    })
    .remainingAccounts(remainingAccountMetas(makerAtas))
    .instruction();
}

/**
 * Builds the right instruction for a `toInstructionPlan` result (`intent.ts`),
 * so callers (the trade panel) only need to translate an `Intent` into a
 * `plan` and never switch on `plan.ix` themselves.
 */
export async function planToInstruction(ctx: BuildCtx, plan: InstructionPlan): Promise<TransactionInstruction> {
  switch (plan.ix) {
    case "place_order":
      return placeOrder(ctx, { side: plan.side, price: plan.price, qty: plan.qty, tif: plan.tif, makers: plan.makers });
    case "buy_no_market":
      return buyNoMarket(ctx, { qty: plan.qty, minYesPrice: plan.minYesPrice, makers: plan.makers });
    case "buy_no_limit":
      return buyNoLimit(ctx, { qty: plan.qty, price: plan.price });
    case "sell_no_market":
      return sellNoMarket(ctx, { qty: plan.qty, maxYesPrice: plan.maxYesPrice, makers: plan.makers });
    default: {
      const exhaustive: never = plan;
      throw new Error(`planToInstruction: unhandled plan ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Sends a set of instructions as one transaction via the wallet adapter's
 * `sendTransaction`, then waits for confirmation. `sendTransaction` matches
 * `@solana/wallet-adapter-react`'s `useWallet().sendTransaction` shape.
 */
export async function sendTx(
  connection: Connection,
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<TransactionSignature>,
  ixs: TransactionInstruction[],
  feePayer: PublicKey,
): Promise<TransactionSignature> {
  const tx = new Transaction();
  tx.add(...ixs);
  tx.feePayer = feePayer;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  // Simulate through the app's own connection first. Wallets simulate on
  // their own RPC and some (Phantom in Localnet mode) cannot; this also turns
  // a program refusal into a readable error with the program's logs before
  // the user is asked to sign anything.
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    const logs = simulation.value.logs ?? [];
    console.error("[meridian] simulation failed", simulation.value.err, logs);
    const anchorLine = logs.find((l) => l.includes("Error Code:")) ?? logs.find((l) => l.includes("failed"));
    const selfMatch = logs.some((l) => l.includes("self-match"));
    throw new Error(`Simulation failed: ${selfMatch ? "SelfMatch" : ""} ${anchorLine ?? JSON.stringify(simulation.value.err)}`);
  }

  const signature = await sendTransaction(tx, connection);
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) {
    // The transaction landed but failed on-chain: never clear inputs or
    // proceed as if it succeeded (item 9). The thrown error still flows
    // through `mapSendError` for user-facing copy.
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

/** Known on-chain error names this file maps to user-facing copy (see `trade-copy.ts`). */
const KNOWN_ERROR_NAMES = ["Paused", "BookFull", "InsufficientFill", "MarketSettled", "MarketClosed", "WrongSide", "SelfMatch"] as const;

function extractErrorName(error: unknown): string | undefined {
  if (error !== null && typeof error === "object") {
    const anchorError = error as { error?: { errorCode?: { code?: string } } };
    const code = anchorError.error?.errorCode?.code;
    if (typeof code === "string") {
      return code;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      for (const name of KNOWN_ERROR_NAMES) {
        if (message.includes(name)) {
          return name;
        }
      }
    }
  }
  return undefined;
}

/**
 * Maps a failed send/simulate error to user-facing copy (never a raw
 * program error code). Unknown errors fall back to a generic message.
 */
export function mapSendError(error: unknown): string {
  const name = extractErrorName(error);
  const message = error instanceof Error ? error.message : undefined;
  const detail = message?.match(/Error Message: ([^.]+)\./)?.[1];
  return programErrorCopy(name, name === undefined ? detail : undefined);
}
