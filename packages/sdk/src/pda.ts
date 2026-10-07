/**
 * PDA derivations mirroring data-model.md exactly. All integer encodings are
 * little-endian, matching the program's Rust/Borsh layout.
 */

import { PublicKey } from "@solana/web3.js";
import { tickerSymbolBytes, type Ticker } from "./types";

function u32LE(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`u32LE: ${value} is not an integer in [0, 0xFFFFFFFF]`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

function u64LE(value: bigint): Buffer {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 64n) {
    throw new Error(`u64LE: ${value} is not a bigint in [0, 2^64)`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

/** Config — PDA `["config"]`, singleton. */
export function configPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
}

/** Market — PDA `["market", ticker_symbol(8), trading_day_le_u32, strike_le_u64]`. */
export function marketPda(
  programId: PublicKey,
  ticker: Ticker,
  tradingDay: number,
  strike: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(tickerSymbolBytes(ticker)), u32LE(tradingDay), u64LE(strike)],
    programId,
  );
}

/** Book — PDA `["book", market]`. */
export function bookPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("book"), market.toBuffer()], programId);
}

/** MockPriceUpdate — PDA `["mock_price", feed_id(32)]`. */
export function mockPricePda(programId: PublicKey, feedIdBytes: Uint8Array): [PublicKey, number] {
  if (feedIdBytes.length !== 32) {
    throw new Error(`mockPricePda: feedIdBytes must be exactly 32 bytes, got ${feedIdBytes.length}`);
  }
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mock_price"), Buffer.from(feedIdBytes)],
    programId,
  );
}

/** Vault — PDA `["vault", market]`; the USDC token account owned by the market PDA. */
export function vaultPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId);
}

/** USDC escrow — PDA `["escrow_usdc", market]`; funds the book's resting bids. */
export function usdcEscrowPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_usdc"), market.toBuffer()],
    programId,
  );
}

/** Yes escrow — PDA `["escrow_yes", market]`; funds the book's resting asks. */
export function yesEscrowPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_yes"), market.toBuffer()],
    programId,
  );
}

/**
 * Yes mint — PDA `["yes_mint", market]`; the SPL mint for a market's Yes token
 * (added in Wave 2/T020 alongside `create_market`, mint authority = market PDA).
 */
export function yesMintPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("yes_mint"), market.toBuffer()], programId);
}

/**
 * No mint — PDA `["no_mint", market]`; the SPL mint for a market's No token
 * (added in Wave 2/T020 alongside `create_market`, mint authority = market PDA).
 */
export function noMintPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("no_mint"), market.toBuffer()], programId);
}
