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

import { PublicKey, SystemProgram } from "@solana/web3.js";
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

/**
 * Wraps a built method call's `.rpc()` send, turning any failure into a
 * short, user-safe message. The underlying error (RPC/Anchor/wallet
 * rejection) is logged to the console for diagnosis, never shown as-is in
 * the UI.
 */
async function sendTx(label: string, build: () => Promise<string>): Promise<string> {
  try {
    return await build();
  } catch (err) {
    console.error(`${label} failed:`, err);
    throw new Error(`${label} did not go through. Please try again.`);
  }
}

/** Mints `qty` pairs (1 Yes + 1 No per unit) for `market`, paid for from the wallet's USDC account. */
export async function mintPair(
  program: Program,
  wallet: PublicKey,
  market: RedeemMarket,
  usdcMint: PublicKey,
  qty: bigint,
): Promise<string> {
  const [configAddress] = configPda(PROGRAM_ID);
  const userUsdc = associatedTokenAddress(wallet, usdcMint);
  const userYes = associatedTokenAddress(wallet, market.yesMint);
  const userNo = associatedTokenAddress(wallet, market.noMint);

  return sendTx("Minting pair", () =>
    (
      program.methods as unknown as {
        mintPair: (qty: BN) => { accounts: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> } };
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
      .rpc(),
  );
}

/** Redeems `qty` matched pairs (burns `qty` Yes + `qty` No) for `qty` USDC back; allowed in any market state, paused or not (FR-006/034). */
export async function redeemPair(
  program: Program,
  wallet: PublicKey,
  market: RedeemMarket,
  usdcMint: PublicKey,
  qty: bigint,
): Promise<string> {
  const [configAddress] = configPda(PROGRAM_ID);
  const userUsdc = associatedTokenAddress(wallet, usdcMint);
  const userYes = associatedTokenAddress(wallet, market.yesMint);
  const userNo = associatedTokenAddress(wallet, market.noMint);

  return sendTx("Redeeming pair", () =>
    (
      program.methods as unknown as {
        redeemPair: (qty: BN) => { accounts: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> } };
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
      .rpc(),
  );
}

/** Redeems `qty` of the winning side (`outcome`) for `qty` USDC, one dollar each (FR-022); allowed even while paused (FR-034), since `redeem_winning` takes no `Config` account at all. */
export async function redeemWinning(
  program: Program,
  wallet: PublicKey,
  market: RedeemMarket,
  usdcMint: PublicKey,
  outcome: "yes" | "no",
  qty: bigint,
): Promise<string> {
  const userUsdc = associatedTokenAddress(wallet, usdcMint);
  const userWinning = associatedTokenAddress(wallet, outcome === "yes" ? market.yesMint : market.noMint);
  const side = outcome === "yes" ? 1 : 2;

  return sendTx("Redeeming winning tokens", () =>
    (
      program.methods as unknown as {
        redeemWinning: (
          side: number,
          qty: BN,
        ) => { accounts: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> } };
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
      .rpc(),
  );
}
