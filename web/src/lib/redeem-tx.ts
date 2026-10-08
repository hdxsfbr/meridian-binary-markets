/**
 * Transaction builders for the three Portfolio actions (T077/T078): mint a
 * pair, redeem a matched pair, and redeem the winning side -- each a single
 * wallet approval (FR-006, FR-022, FR-034). Uses the Anchor `Program`
 * methods API (`program.methods.<ix>(...).accounts({...}).rpc()`) with
 * every account passed explicitly, matching the account lists in
 * `programs/meridian/src/instructions/{mint_pair,redeem_pair,redeem_winning}.rs`
 * and the generated IDL.
 *
 * Deliberately self-contained: agent C is building a similar `sendTx`
 * helper concurrently in `web/src/lib/tx.ts` for the trade panel, so this
 * module does not import from there.
 */

import { PublicKey, SystemProgram, type Connection, type Transaction, type TransactionInstruction, type TransactionSignature } from "@solana/web3.js";
import { sendTx as broadcast } from "./tx";
import { BN, type Program } from "@anchor-lang/core";
import { configPda } from "@meridian/sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, associatedTokenAddress } from "./ata";
import { PROGRAM_ID } from "./rpc";
import { accountClient } from "@/hooks/useProgram";

/** The subset of a `Market` account these builders need to fill in accounts. */
export type RedeemMarket = {
  pubkey: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
};

type RawConfigUsdcMint = { usdcMint: PublicKey };

/** Fetches `Config.usdc_mint` directly (not via `useConfig`, which doesn't decode it). */
export async function getUsdcMint(program: Program): Promise<PublicKey> {
  const [configAddress] = configPda(PROGRAM_ID);
  const raw = (await accountClient(program, "config").fetchNullable(configAddress)) as RawConfigUsdcMint | null;
  if (raw === null) {
    throw new Error("Could not load the program configuration. Try again in a moment.");
  }
  return raw.usdcMint;
}

/** Same shape as `useWallet().sendTransaction`; callers pass `useSendTransaction()` so the wallet only signs and the app broadcasts. */
export type SendFn = (tx: Transaction, connection: Connection) => Promise<TransactionSignature>;

/**
 * Builds the instruction, simulates it, has the wallet sign it and broadcasts
 * through the app's connection (shared `sendTx` in tx.ts). Any failure becomes
 * a short, user-safe message; the underlying error is logged for diagnosis.
 */
async function sendTx(
  label: string,
  connection: Connection,
  sendTransaction: SendFn,
  feePayer: PublicKey,
  build: () => Promise<TransactionInstruction>,
): Promise<string> {
  try {
    const ix = await build();
    return await broadcast(connection, sendTransaction, [ix], feePayer);
  } catch (err) {
    console.error(`${label} failed:`, err);
    const detail = err instanceof Error ? err.message.match(/Error Message: ([^.]+)\./)?.[1] : undefined;
    throw new Error(detail ? `${label} did not go through: ${detail}.` : `${label} did not go through. Please try again.`);
  }
}

/** Mints `qty` pairs (1 Yes + 1 No per unit) for `market`, paid for from the wallet's USDC account. */
export async function mintPair(
  program: Program,
  connection: Connection,
  sendTransaction: SendFn,
  wallet: PublicKey,
  market: RedeemMarket,
  usdcMint: PublicKey,
  qty: bigint,
): Promise<string> {
  const [configAddress] = configPda(PROGRAM_ID);
  const userUsdc = associatedTokenAddress(wallet, usdcMint);
  const userYes = associatedTokenAddress(wallet, market.yesMint);
  const userNo = associatedTokenAddress(wallet, market.noMint);

  return sendTx("Minting pair", connection, sendTransaction, wallet, () =>
    (
      program.methods as unknown as {
        mintPair: (qty: BN) => { accounts: (a: Record<string, PublicKey>) => { instruction: () => Promise<TransactionInstruction> } };
      }
    )
      .mintPair(new BN(qty.toString()))
      .accounts({
        user: wallet,
        config: configAddress,
        market: market.pubkey,
        yesMint: market.yesMint,
        noMint: market.noMint,
        vault: market.vault,
        userUsdc,
        userYes,
        userNo,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  );
}

/**
 * Builds a `redeem_pair` instruction without sending it, so "Redeem all"
 * (`redeem-all.ts`) can batch several of these (and `buildRedeemWinningInstruction`
 * below) into one transaction instead of one wallet approval each.
 */
export function buildRedeemPairInstruction(
  program: Program,
  wallet: PublicKey,
  market: RedeemMarket,
  usdcMint: PublicKey,
  qty: bigint,
): Promise<TransactionInstruction> {
  const [configAddress] = configPda(PROGRAM_ID);
  const userUsdc = associatedTokenAddress(wallet, usdcMint);
  const userYes = associatedTokenAddress(wallet, market.yesMint);
  const userNo = associatedTokenAddress(wallet, market.noMint);

  return (
    program.methods as unknown as {
      redeemPair: (qty: BN) => { accounts: (a: Record<string, PublicKey>) => { instruction: () => Promise<TransactionInstruction> } };
    }
  )
    .redeemPair(new BN(qty.toString()))
    .accounts({
      user: wallet,
      config: configAddress,
      market: market.pubkey,
      yesMint: market.yesMint,
      noMint: market.noMint,
      vault: market.vault,
      userUsdc,
      userYes,
      userNo,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** Redeems `qty` matched pairs (burns `qty` Yes + `qty` No) for `qty` USDC back; allowed in any market state, paused or not (FR-006/034). */
export async function redeemPair(
  program: Program,
  connection: Connection,
  sendTransaction: SendFn,
  wallet: PublicKey,
  market: RedeemMarket,
  usdcMint: PublicKey,
  qty: bigint,
): Promise<string> {
  return sendTx("Redeeming pair", connection, sendTransaction, wallet, () =>
    buildRedeemPairInstruction(program, wallet, market, usdcMint, qty),
  );
}

/**
 * Builds a `redeem_winning` instruction without sending it, so "Redeem all"
 * (`redeem-all.ts`) can batch several of these (and `buildRedeemPairInstruction`
 * above) into one transaction instead of one wallet approval each.
 */
export function buildRedeemWinningInstruction(
  program: Program,
  wallet: PublicKey,
  market: RedeemMarket,
  usdcMint: PublicKey,
  outcome: "yes" | "no",
  qty: bigint,
): Promise<TransactionInstruction> {
  const userUsdc = associatedTokenAddress(wallet, usdcMint);
  const userWinning = associatedTokenAddress(wallet, outcome === "yes" ? market.yesMint : market.noMint);
  const side = outcome === "yes" ? 1 : 2;

  return (
    program.methods as unknown as {
      redeemWinning: (
        side: number,
        qty: BN,
      ) => { accounts: (a: Record<string, PublicKey>) => { instruction: () => Promise<TransactionInstruction> } };
    }
  )
    .redeemWinning(side, new BN(qty.toString()))
    .accounts({
      user: wallet,
      market: market.pubkey,
      yesMint: market.yesMint,
      noMint: market.noMint,
      vault: market.vault,
      userUsdc,
      userWinning,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** Redeems `qty` of the winning side (`outcome`) for `qty` USDC, one dollar each (FR-022); allowed even while paused (FR-034), since `redeem_winning` takes no `Config` account at all. */
export async function redeemWinning(
  program: Program,
  connection: Connection,
  sendTransaction: SendFn,
  wallet: PublicKey,
  market: RedeemMarket,
  usdcMint: PublicKey,
  outcome: "yes" | "no",
  qty: bigint,
): Promise<string> {
  return sendTx("Redeeming winning tokens", connection, sendTransaction, wallet, () =>
    buildRedeemWinningInstruction(program, wallet, market, usdcMint, outcome, qty),
  );
}
