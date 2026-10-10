import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  FEED_IDS,
  feedIdBytes,
  ONE_USDC,
  PRICE_MAX,
  KNOWN_TICKERS,
  TICKERS,
  tickerFromBytes,
  tickerSymbolBytes,
} from "../src/types";

describe("FEED_IDS", () => {
  it("has a distinct 64-character hex feed id for every known ticker, and the default set is a subset", () => {
    const hexes = KNOWN_TICKERS.map((t) => FEED_IDS[t]);
    expect(hexes.length).toBeGreaterThanOrEqual(TICKERS.length);
    for (const hex of hexes) {
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const t of TICKERS) {
      expect(KNOWN_TICKERS).toContain(t);
    }
    expect(() => feedIdBytes("NOPE")).toThrow(/no known Pyth feed/);
  });
});

describe("TICKERS default set (DECISIONS.md §30: the PRD seven; BTC stays in the catalogue)", () => {
  it("is the PRD seven, TSLA included and BTC excluded", () => {
    expect(TICKERS).toContain("TSLA");
    expect(TICKERS).not.toContain("BTC");
    expect(TICKERS).toHaveLength(7);
  });

  it("keeps BTC in the catalogue (FEED_IDS/KNOWN_TICKERS) for weekend demos and existing markets", () => {
    expect(KNOWN_TICKERS).toContain("BTC");
    expect(FEED_IDS.BTC).toMatch(/^[0-9a-f]{64}$/);
  });

  it("BTC's feed id is the verified Crypto.BTC/USD Pyth feed", () => {
    expect(FEED_IDS.BTC).toBe("e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43");
  });
});

describe("feedIdBytes", () => {
  it("decodes to exactly 32 bytes and round-trips to the original hex", () => {
    for (const ticker of TICKERS) {
      const bytes = feedIdBytes(ticker);
      expect(bytes).toHaveLength(32);
      expect(bytesToHex(bytes)).toBe(FEED_IDS[ticker]);
    }
  });
});

describe("tickerSymbolBytes / tickerFromBytes", () => {
  it("round-trips a symbol that is not in the catalogue (the listed set is config-driven)", () => {
    expect(tickerFromBytes(tickerSymbolBytes("BRK.B"))).toBe("BRK.B");
    expect(() => tickerSymbolBytes("toolongsymbol")).toThrow();
    expect(() => tickerFromBytes(new Uint8Array([65, 0, 66, 0, 0, 0, 0, 0]))).toThrow(/padding/);
  });

  it("encodes to 8 bytes, zero-padded, and round-trips for every ticker", () => {
    for (const ticker of TICKERS) {
      const bytes = tickerSymbolBytes(ticker);
      expect(bytes).toHaveLength(8);
      expect(tickerFromBytes(bytes)).toBe(ticker);
    }
  });

  it("zero-pads short symbols", () => {
    const bytes = tickerSymbolBytes("AAPL");
    expect(Array.from(bytes)).toEqual([65, 65, 80, 76, 0, 0, 0, 0]);
  });

  it("accepts a symbol outside the catalogue (the listed set is the on-chain Config, not this file)", () => {
    const xyz = new Uint8Array(8);
    xyz.set([88, 89, 90]); // "XYZ"
    expect(tickerFromBytes(xyz)).toBe("XYZ");
  });

  it("throws on bytes that are AAPL with the high bit set on each byte (no ASCII masking)", () => {
    const highBitAapl = new Uint8Array([193, 193, 208, 204, 0, 0, 0, 0]);
    expect(() => tickerFromBytes(highBitAapl)).toThrow();
  });

  it("throws on a 7-byte input", () => {
    const sevenBytes = new Uint8Array(7);
    expect(() => tickerFromBytes(sevenBytes)).toThrow();
  });
});

describe("constants", () => {
  it("ONE_USDC and PRICE_MAX match the data model", () => {
    expect(ONE_USDC).toBe(1_000_000n);
    expect(PRICE_MAX).toBe(999_999n);
  });
});
