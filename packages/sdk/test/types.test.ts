import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  FEED_IDS,
  feedIdBytes,
  ONE_USDC,
  PRICE_MAX,
  TICKERS,
  tickerFromBytes,
  tickerSymbolBytes,
} from "../src/types";

describe("FEED_IDS", () => {
  it("has all seven tickers, each a distinct 64-character hex string", () => {
    const hexes = TICKERS.map((t) => FEED_IDS[t]);
    expect(hexes).toHaveLength(7);
    for (const hex of hexes) {
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(hexes).size).toBe(7);
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

  it("throws on an unknown symbol", () => {
    const bogus = new Uint8Array(8);
    bogus.set([88, 89, 90]); // "XYZ"
    expect(() => tickerFromBytes(bogus)).toThrow();
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
