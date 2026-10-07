import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  bookPda,
  configPda,
  marketPda,
  mockPricePda,
  usdcEscrowPda,
  vaultPda,
  yesEscrowPda,
} from "../src/pda";
import { feedIdBytes } from "../src/types";

const programId = new PublicKey("11111111111111111111111111111111");

describe("configPda", () => {
  it("is deterministic", () => {
    const [a, bumpA] = configPda(programId);
    const [b, bumpB] = configPda(programId);
    expect(a.toBase58()).toBe(b.toBase58());
    expect(bumpA).toBe(bumpB);
  });
});

describe("marketPda", () => {
  it("is deterministic for identical inputs", () => {
    const [a] = marketPda(programId, "AAPL", 20260106, 150_000_000n);
    const [b] = marketPda(programId, "AAPL", 20260106, 150_000_000n);
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it("differs across ticker", () => {
    const [a] = marketPda(programId, "AAPL", 20260106, 150_000_000n);
    const [b] = marketPda(programId, "MSFT", 20260106, 150_000_000n);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  it("differs across trading_day", () => {
    const [a] = marketPda(programId, "AAPL", 20260106, 150_000_000n);
    const [b] = marketPda(programId, "AAPL", 20260107, 150_000_000n);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  it("differs across strike", () => {
    const [a] = marketPda(programId, "AAPL", 20260106, 150_000_000n);
    const [b] = marketPda(programId, "AAPL", 20260106, 160_000_000n);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

describe("bookPda / vaultPda / usdcEscrowPda / yesEscrowPda", () => {
  const [market] = marketPda(programId, "AAPL", 20260106, 150_000_000n);
  const [otherMarket] = marketPda(programId, "MSFT", 20260106, 150_000_000n);

  it("are deterministic and distinct from each other for the same market", () => {
    const [book] = bookPda(programId, market);
    const [vault] = vaultPda(programId, market);
    const [usdcEscrow] = usdcEscrowPda(programId, market);
    const [yesEscrow] = yesEscrowPda(programId, market);
    const addresses = [book, vault, usdcEscrow, yesEscrow].map((pk) => pk.toBase58());
    expect(new Set(addresses).size).toBe(4);

    const [book2] = bookPda(programId, market);
    expect(book.toBase58()).toBe(book2.toBase58());
  });

  it("differ across markets", () => {
    const [bookA] = bookPda(programId, market);
    const [bookB] = bookPda(programId, otherMarket);
    expect(bookA.toBase58()).not.toBe(bookB.toBase58());
  });
});

describe("mockPricePda", () => {
  it("is deterministic and differs across feed ids", () => {
    const [a] = mockPricePda(programId, feedIdBytes("AAPL"));
    const [b] = mockPricePda(programId, feedIdBytes("AAPL"));
    const [c] = mockPricePda(programId, feedIdBytes("MSFT"));
    expect(a.toBase58()).toBe(b.toBase58());
    expect(a.toBase58()).not.toBe(c.toBase58());
  });

  it("throws on a 31-byte feed id", () => {
    expect(() => mockPricePda(programId, new Uint8Array(31))).toThrow();
  });

  it("throws on a 33-byte feed id", () => {
    expect(() => mockPricePda(programId, new Uint8Array(33))).toThrow();
  });
});

describe("marketPda input validation", () => {
  it("throws on a non-integer trading_day", () => {
    expect(() => marketPda(programId, "AAPL", 20261006.5, 150_000_000n)).toThrow();
  });

  it("throws on a negative trading_day", () => {
    expect(() => marketPda(programId, "AAPL", -1, 150_000_000n)).toThrow();
  });

  it("throws on a strike at 2^64", () => {
    expect(() => marketPda(programId, "AAPL", 20260106, 1n << 64n)).toThrow();
  });
});
