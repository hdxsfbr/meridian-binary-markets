#!/usr/bin/env -S node --
/**
 * `make` target / `pnpm --filter @meridian/scripts run rent-estimate`.
 *
 * Prints the rent (`getMinimumBalanceForRentExemption`) for every account a
 * market creates -- Market, Book (at both book capacities: demo-scale 16
 * and default 128), the two SPL mints, and the three token accounts (vault,
 * USDC escrow, Yes escrow) -- then per-market and per-day totals for 45
 * markets/day (research.md R4: 7 tickers x ~5-7 strikes) at both
 * capacities, matching the table in research.md R7.
 *
 * `--json` prints the same numbers as JSON instead of a table.
 */

import { fileURLToPath } from "node:url";
import { loadScriptEnv } from "./lib/env.js";
import { createConnection, MINT_SPACE, TOKEN_ACCOUNT_SPACE } from "./lib/client.js";
import { IDL } from "@meridian/sdk";

/** research.md R4: 7 tickers x 5-7 deduplicated strikes each trading day. */
export const MARKETS_PER_DAY = 45;

/** Demo-scale and production-default order-book capacities (DECISIONS §6, R7). */
export const BOOK_CAPACITY_DEMO = 16;
export const BOOK_CAPACITY_DEFAULT = 128;

/**
 * Total byte size of a Book account for a given per-side `capacity`:
 * 8-byte discriminator + 120-byte header + 2 * capacity * 64-byte Order
 * records (programs/meridian/src/state/book.rs `book_space`). Reproduced
 * here (not imported -- this is a TS package with no access to the Rust
 * crate) and cross-checked against `cargo test`'s `book_space_for_*`
 * fixtures: capacity 16 -> 2176 bytes, capacity 128 -> 16512 bytes.
 */
export function bookSpace(capacityPerSide: number): number {
  const HEADER_SPACE = 120; // BookHeader: 3 pubkeys (96) + 2 u64 (16) + capacity/bid_count/ask_count u16 (6) + 2 pad
  const ORDER_SPACE = 64;
  const DISCRIMINATOR = 8;
  return DISCRIMINATOR + HEADER_SPACE + 2 * capacityPerSide * ORDER_SPACE;
}

const PRIMITIVE_SIZES: Record<string, number> = {
  u8: 1,
  i8: 1,
  bool: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  i128: 16,
  pubkey: 32,
};

interface IdlTypeDef {
  name: string;
  type: {
    kind: string;
    fields?: Array<{ name: string; type: unknown }>;
    variants?: Array<{ name: string; fields?: unknown[] }>;
  };
}

export interface IdlLike {
  types?: IdlTypeDef[];
}

/**
 * Resolves the on-chain byte size of an IDL field `type`, recursively, so
 * `marketAccountSpace` below reads the real layout of `Market` (and
 * anything it is made of) out of the generated IDL rather than a
 * hand-maintained constant that can silently drift from `state/market.rs`.
 * Handles primitives, fixed arrays, and `defined` references to fieldless
 * enums (1-byte discriminant, matching `#[derive(InitSpace)]` on
 * `MarketState`/`Outcome`) or plain structs.
 */
export function idlTypeSize(idl: IdlLike, type: unknown): number {
  if (typeof type === "string") {
    const size = PRIMITIVE_SIZES[type];
    if (size === undefined) {
      throw new Error(`idlTypeSize: unsupported primitive type "${type}"`);
    }
    return size;
  }
  if (type && typeof type === "object") {
    const obj = type as Record<string, unknown>;
    if (Array.isArray(obj.array)) {
      const [elem, len] = obj.array as [unknown, number];
      return len * idlTypeSize(idl, elem);
    }
    if (obj.defined) {
      const name = typeof obj.defined === "string" ? obj.defined : (obj.defined as { name: string }).name;
      const def = (idl.types ?? []).find((t) => t.name === name);
      if (!def) {
        throw new Error(`idlTypeSize: no IDL type definition for "${name}"`);
      }
      if (def.type.kind === "enum") {
        const anyVariantHasFields = (def.type.variants ?? []).some(
          (v) => Array.isArray(v.fields) && v.fields.length > 0,
        );
        if (anyVariantHasFields) {
          throw new Error(`idlTypeSize: enum "${name}" has data-carrying variants, not supported`);
        }
        return 1;
      }
      const fields = def.type.fields ?? [];
      return fields.reduce((sum, f) => sum + idlTypeSize(idl, f.type), 0);
    }
  }
  throw new Error(`idlTypeSize: unsupported type ${JSON.stringify(type)}`);
}

/**
 * Byte size of a `Market` account (8-byte Anchor discriminator + the sum
 * of every field's size, read from the IDL's `types` entry for `Market`).
 */
export function marketAccountSpace(idl: IdlLike): number {
  const def = (idl.types ?? []).find((t) => t.name === "Market" && t.type.kind === "struct");
  if (!def) {
    throw new Error("marketAccountSpace: no IDL struct type named \"Market\"");
  }
  const fields = def.type.fields ?? [];
  const body = fields.reduce((sum, f) => sum + idlTypeSize(idl, f.type), 0);
  return 8 + body;
}

export interface RentInputs {
  marketLamports: bigint;
  bookLamports: bigint;
  mintLamports: bigint;
  tokenAccountLamports: bigint;
  marketsPerDay: number;
}

export interface RentTotals {
  /** Market + Book + 2 mints + 3 token accounts (vault, USDC escrow, Yes escrow). */
  perMarketLamports: bigint;
  perDayLamports: bigint;
}

/**
 * Pure arithmetic over already-fetched rent-exemption lamports: one
 * market's full account set is Market + Book + 2 mints (Yes, No) + 3 token
 * accounts (vault, USDC escrow, Yes escrow); per-day totals multiply by
 * `marketsPerDay` (research.md R4: 45).
 */
export function computeRentTotals(inputs: RentInputs): RentTotals {
  const perMarketLamports =
    inputs.marketLamports +
    inputs.bookLamports +
    2n * inputs.mintLamports +
    3n * inputs.tokenAccountLamports;
  const perDayLamports = perMarketLamports * BigInt(inputs.marketsPerDay);
  return { perMarketLamports, perDayLamports };
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1_000_000_000;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const env = loadScriptEnv();
  const connection = createConnection(env.solanaRpcUrl);

  const marketSpace = marketAccountSpace(IDL as unknown as IdlLike);
  const bookSpaceDemo = bookSpace(BOOK_CAPACITY_DEMO);
  const bookSpaceDefault = bookSpace(BOOK_CAPACITY_DEFAULT);

  const [marketLamports, bookLamportsDemo, bookLamportsDefault, mintLamports, tokenAccountLamports] =
    await Promise.all([
      connection.getMinimumBalanceForRentExemption(marketSpace),
      connection.getMinimumBalanceForRentExemption(bookSpaceDemo),
      connection.getMinimumBalanceForRentExemption(bookSpaceDefault),
      connection.getMinimumBalanceForRentExemption(MINT_SPACE),
      connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SPACE),
    ]);

  const totalsDemo = computeRentTotals({
    marketLamports: BigInt(marketLamports),
    bookLamports: BigInt(bookLamportsDemo),
    mintLamports: BigInt(mintLamports),
    tokenAccountLamports: BigInt(tokenAccountLamports),
    marketsPerDay: MARKETS_PER_DAY,
  });
  const totalsDefault = computeRentTotals({
    marketLamports: BigInt(marketLamports),
    bookLamports: BigInt(bookLamportsDefault),
    mintLamports: BigInt(mintLamports),
    tokenAccountLamports: BigInt(tokenAccountLamports),
    marketsPerDay: MARKETS_PER_DAY,
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          cluster: env.cluster,
          accountBytes: {
            market: marketSpace,
            bookDemo16: bookSpaceDemo,
            bookDefault128: bookSpaceDefault,
            mint: MINT_SPACE,
            tokenAccount: TOKEN_ACCOUNT_SPACE,
          },
          accountRentLamports: {
            market: marketLamports,
            bookDemo16: bookLamportsDemo,
            bookDefault128: bookLamportsDefault,
            mint: mintLamports,
            tokenAccount: tokenAccountLamports,
          },
          marketsPerDay: MARKETS_PER_DAY,
          demoScale16: {
            perMarketLamports: totalsDemo.perMarketLamports.toString(),
            perMarketSol: lamportsToSol(totalsDemo.perMarketLamports),
            perDayLamports: totalsDemo.perDayLamports.toString(),
            perDaySol: lamportsToSol(totalsDemo.perDayLamports),
          },
          default128: {
            perMarketLamports: totalsDefault.perMarketLamports.toString(),
            perMarketSol: lamportsToSol(totalsDefault.perMarketLamports),
            perDayLamports: totalsDefault.perDayLamports.toString(),
            perDaySol: lamportsToSol(totalsDefault.perDayLamports),
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Rent estimate (cluster: ${env.cluster})`);
  console.log("");
  console.log("Account            | Bytes  | Rent (lamports) | Rent (SOL)");
  console.log("--------------------|--------|------------------|-----------");
  console.log(
    `Market              | ${String(marketSpace).padEnd(6)} | ${String(marketLamports).padEnd(16)} | ${lamportsToSol(BigInt(marketLamports)).toFixed(6)}`,
  );
  console.log(
    `Book (cap 16)       | ${String(bookSpaceDemo).padEnd(6)} | ${String(bookLamportsDemo).padEnd(16)} | ${lamportsToSol(BigInt(bookLamportsDemo)).toFixed(6)}`,
  );
  console.log(
    `Book (cap 128)      | ${String(bookSpaceDefault).padEnd(6)} | ${String(bookLamportsDefault).padEnd(16)} | ${lamportsToSol(BigInt(bookLamportsDefault)).toFixed(6)}`,
  );
  console.log(
    `Mint (x1)           | ${String(MINT_SPACE).padEnd(6)} | ${String(mintLamports).padEnd(16)} | ${lamportsToSol(BigInt(mintLamports)).toFixed(6)}`,
  );
  console.log(
    `Token account (x1)  | ${String(TOKEN_ACCOUNT_SPACE).padEnd(6)} | ${String(tokenAccountLamports).padEnd(16)} | ${lamportsToSol(BigInt(tokenAccountLamports)).toFixed(6)}`,
  );
  console.log("");
  console.log(`Per market = Market + Book + 2 mints (Yes, No) + 3 token accounts (vault, USDC escrow, Yes escrow)`);
  console.log(`Per day = per market x ${MARKETS_PER_DAY} markets/day (research.md R4)`);
  console.log("");
  console.log("Config                       | Per market (SOL) | Per day (SOL)");
  console.log("------------------------------|-------------------|---------------");
  console.log(
    `Demo scale (book cap 16)      | ${lamportsToSol(totalsDemo.perMarketLamports).toFixed(6).padEnd(17)} | ${lamportsToSol(totalsDemo.perDayLamports).toFixed(4)}`,
  );
  console.log(
    `Default (book cap 128)        | ${lamportsToSol(totalsDefault.perMarketLamports).toFixed(6).padEnd(17)} | ${lamportsToSol(totalsDefault.perDayLamports).toFixed(4)}`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
