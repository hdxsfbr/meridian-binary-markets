import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { Ticker } from "@meridian/sdk";
import { runPublisherJob, runPublisherTick, type PublisherChain } from "../src/jobs/publisher";
import type { PriceProvider } from "../src/providers/PriceProvider";

const PRICE_ACCOUNT = new PublicKey("11111111111111111111111111111113");

function fakeChain(tickers: Array<{ symbol: Ticker; enabled: boolean }>): PublisherChain {
  return {
    async fetchConfig() {
      return { tickers };
    },
  };
}

describe("publisher job", () => {
  it("refuses to run with the pyth provider", async () => {
    const chain = fakeChain([{ symbol: "META" as Ticker, enabled: true }]);
    const provider: PriceProvider = {
      publish: vi.fn(),
      previousClose: vi.fn(),
      currentPrice: vi.fn(),
    } as unknown as PriceProvider;

    await expect(
      runPublisherJob({ chain, provider, oracleProvider: "pyth" }, { once: true }),
    ).rejects.toThrow(/mock provider only/);

    await expect(runPublisherTick({ chain, provider, oracleProvider: "pyth" })).rejects.toThrow(/mock provider only/);
  });

  it("publishes once for every enabled ticker and skips disabled ones", async () => {
    const chain = fakeChain([
      { symbol: "META" as Ticker, enabled: true },
      { symbol: "TSLA" as Ticker, enabled: true },
      { symbol: "NVDA" as Ticker, enabled: false },
    ]);
    const publish = vi.fn().mockResolvedValue({ priceAccount: PRICE_ACCOUNT, publishTime: 1_759_780_900 });
    const provider: PriceProvider = { publish, previousClose: vi.fn(), currentPrice: vi.fn() };

    await runPublisherTick({ chain, provider, oracleProvider: "mock" });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith("META");
    expect(publish).toHaveBeenCalledWith("TSLA");
    expect(publish).not.toHaveBeenCalledWith("NVDA");
  });

  it("a source failure on one ticker does not block the others, and writes nothing for it", async () => {
    const chain = fakeChain([
      { symbol: "META" as Ticker, enabled: true },
      { symbol: "TSLA" as Ticker, enabled: true },
    ]);
    const publish = vi.fn().mockImplementation(async (ticker: Ticker) => {
      if (ticker === "META") throw new Error("finnhub source outage");
      return { priceAccount: PRICE_ACCOUNT, publishTime: 1_759_780_900 };
    });
    const provider: PriceProvider = { publish, previousClose: vi.fn(), currentPrice: vi.fn() };

    await expect(runPublisherTick({ chain, provider, oracleProvider: "mock" })).resolves.toBeUndefined();

    expect(publish).toHaveBeenCalledWith("META");
    expect(publish).toHaveBeenCalledWith("TSLA");
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
