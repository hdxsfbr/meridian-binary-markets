import { describe, expect, it, vi } from "vitest";
import { MockPythProvider } from "../src/providers/MockPythProvider";

const NOW = 1_759_900_300;

function chainWithFeed() {
  return {
    mockWritePrice: vi.fn(),
    fetchConfig: vi.fn().mockResolvedValue({ tickers: [] }),
  };
}

function providerWithSources(opts: {
  financeTradeTime: number;
  nasdaqObservedAt: number;
  finnhubPrice?: bigint;
  nasdaqPrice?: bigint;
}) {
  const finnhubPrice = opts.finnhubPrice ?? 333_410_000n;
  const nasdaqPrice = opts.nasdaqPrice ?? 333_400_000n;
  const fetchFinnhub = vi.fn().mockResolvedValue({
    current: { ticker: "AAPL", source: "finnhub", priceMicro: finnhubPrice, observedAt: opts.financeTradeTime },
    previousClose: 330_000_000n,
    tradeTime: opts.financeTradeTime,
  });
  const fetchNasdaq = vi.fn().mockResolvedValue({
    ticker: "AAPL",
    source: "nasdaq",
    priceMicro: nasdaqPrice,
    observedAt: opts.nasdaqObservedAt,
  });

  return new MockPythProvider({
    chain: chainWithFeed(),
    finnhubApiKey: "finnhub-key",
    fetchFinnhub,
    fetchNasdaq,
    now: () => NOW,
  });
}

describe("MockPythProvider.currentPrice (review fix: applies publish's freshness policy)", () => {
  it("returns the Finnhub price when both sources agree and are fresh", async () => {
    const provider = providerWithSources({ financeTradeTime: NOW - 10, nasdaqObservedAt: NOW - 5 });

    const result = await provider.currentPrice("AAPL");
    expect(result).toBe(333_410_000n);
  });

  it("throws when both sources agree but their observation is older than the staleness threshold", async () => {
    // Fix: previously only the cross-check (agreement) mattered here -- two agreeing but
    // ancient quotes passed silently. Both timestamps are old (5000s), mirroring `publish`'s
    // own STALE_SOURCE_SECS (300s) check, which this method previously skipped entirely.
    const provider = providerWithSources({ financeTradeTime: NOW - 5_000, nasdaqObservedAt: NOW - 5_000 });

    await expect(provider.currentPrice("AAPL")).rejects.toThrow(/staleness threshold/);
  });

  it("throws when only the earlier of the two source timestamps is stale", async () => {
    // Same freshness policy as `publish`: the *earlier* of the two observation times is
    // the one checked, never the fresher one -- so a stale Nasdaq read behind a fresh
    // Finnhub read still fails closed.
    const provider = providerWithSources({ financeTradeTime: NOW - 10, nasdaqObservedAt: NOW - 5_000 });

    await expect(provider.currentPrice("AAPL")).rejects.toThrow(/staleness threshold/);
  });

  it("still throws on disagreement between the two sources, before the freshness check", async () => {
    const provider = providerWithSources({
      financeTradeTime: NOW - 10,
      nasdaqObservedAt: NOW - 5,
      finnhubPrice: 333_410_000n,
      nasdaqPrice: 100_000_000n, // way more than 10% off
    });

    await expect(provider.currentPrice("AAPL")).rejects.toThrow(/disagree by more than 10%/);
  });
});
