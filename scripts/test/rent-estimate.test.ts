import { describe, expect, it } from "vitest";
import {
  bookSpace,
  computeRentTotals,
  idlTypeSize,
  marketAccountSpace,
  MARKETS_PER_DAY,
} from "../rent-estimate.js";

describe("bookSpace", () => {
  it("matches programs/meridian/src/state/book.rs's book_space_for_demo_scale_capacity_16 fixture", () => {
    expect(bookSpace(16)).toBe(2176);
  });

  it("matches programs/meridian/src/state/book.rs's book_space_for_default_capacity_128 fixture", () => {
    expect(bookSpace(128)).toBe(16512);
  });

  it("is linear in capacity: book_space(c) = 128 + 128*c", () => {
    for (const c of [1, 16, 64, 128]) {
      expect(bookSpace(c)).toBe(128 + 128 * c);
    }
  });
});

describe("idlTypeSize / marketAccountSpace", () => {
  const fixtureIdl = {
    types: [
      {
        name: "Flag",
        type: { kind: "enum", variants: [{ name: "On" }, { name: "Off" }] },
      },
      {
        name: "Market",
        type: {
          kind: "struct",
          fields: [
            { name: "ticker", type: { array: ["u8", 8] } },
            { name: "strike", type: "u64" },
            { name: "trading_day", type: "u32" },
            { name: "close_ts", type: "i64" },
            { name: "state", type: { defined: { name: "Flag" } } },
            { name: "outcome", type: { defined: { name: "Flag" } } },
            { name: "settlement_price", type: "u64" },
            { name: "settled_at", type: "i64" },
            { name: "settled_by_override", type: "bool" },
            { name: "yes_mint", type: "pubkey" },
            { name: "no_mint", type: "pubkey" },
            { name: "vault", type: "pubkey" },
            { name: "book", type: "pubkey" },
            { name: "book_capacity", type: "u16" },
            { name: "pairs_outstanding", type: "u64" },
            { name: "bump", type: "u8" },
            { name: "vault_bump", type: "u8" },
          ],
        },
      },
    ],
  };

  it("sizes primitives correctly", () => {
    expect(idlTypeSize(fixtureIdl, "u8")).toBe(1);
    expect(idlTypeSize(fixtureIdl, "bool")).toBe(1);
    expect(idlTypeSize(fixtureIdl, "u16")).toBe(2);
    expect(idlTypeSize(fixtureIdl, "u32")).toBe(4);
    expect(idlTypeSize(fixtureIdl, "u64")).toBe(8);
    expect(idlTypeSize(fixtureIdl, "pubkey")).toBe(32);
  });

  it("sizes fixed arrays correctly", () => {
    expect(idlTypeSize(fixtureIdl, { array: ["u8", 8] })).toBe(8);
    expect(idlTypeSize(fixtureIdl, { array: ["u8", 32] })).toBe(32);
  });

  it("sizes a fieldless enum as 1 byte", () => {
    expect(idlTypeSize(fixtureIdl, { defined: { name: "Flag" } })).toBe(1);
  });

  it("computes Market's full account space (8-byte discriminator + 187-byte body = 195)", () => {
    // ticker(8) + strike(8) + trading_day(4) + close_ts(8) + state(1) + outcome(1) +
    // settlement_price(8) + settled_at(8) + settled_by_override(1) + yes_mint(32) +
    // no_mint(32) + vault(32) + book(32) + book_capacity(2) + pairs_outstanding(8) +
    // bump(1) + vault_bump(1) = 187; + 8-byte discriminator = 195.
    expect(marketAccountSpace(fixtureIdl)).toBe(195);
  });

  it("throws on an unknown defined type", () => {
    expect(() => idlTypeSize(fixtureIdl, { defined: { name: "Nope" } })).toThrow();
  });
});

describe("computeRentTotals", () => {
  it("sums one market's full account set: Market + Book + 2 mints + 3 token accounts", () => {
    const totals = computeRentTotals({
      marketLamports: 1_000n,
      bookLamports: 2_000n,
      mintLamports: 100n,
      tokenAccountLamports: 10n,
      marketsPerDay: 1,
    });
    // 1000 + 2000 + 2*100 + 3*10 = 3230
    expect(totals.perMarketLamports).toBe(3_230n);
    expect(totals.perDayLamports).toBe(3_230n);
  });

  it("multiplies per-market total by marketsPerDay", () => {
    const totals = computeRentTotals({
      marketLamports: 1_000n,
      bookLamports: 2_000n,
      mintLamports: 100n,
      tokenAccountLamports: 10n,
      marketsPerDay: MARKETS_PER_DAY,
    });
    expect(totals.perDayLamports).toBe(3_230n * BigInt(MARKETS_PER_DAY));
  });

  it("uses research.md R4's 45 markets/day constant", () => {
    expect(MARKETS_PER_DAY).toBe(45);
  });
});
