import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNasdaqQuote } from "../src/sources/nasdaq";
import { toMicroUsd } from "../src/sources/types";

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

describe("fetchNasdaqQuote", () => {
  it("parses the happy path from the real Nasdaq response shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          symbol: "AAPL",
          primaryData: {
            lastSalePrice: "$333.41",
            lastTradeTimestamp: "Oct 6, 2026 2:54 PM ET",
            isRealTime: true,
          },
          marketStatus: "Open",
        },
      }),
    );

    const observation = await fetchNasdaqQuote("AAPL", fetchImpl as unknown as typeof fetch);

    expect(observation.ticker).toBe("AAPL");
    expect(observation.source).toBe("nasdaq");
    expect(observation.priceMicro).toBe(333_410_000n);
    expect(observation.marketStatus).toBe("open");
    // "Oct 6, 2026 2:54 PM ET" in America/New_York (EDT, UTC-4).
    expect(observation.observedAt).toBe(Math.floor(new Date("2026-10-06T18:54:00.000Z").getTime() / 1000));

    const [, options] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(options.headers).toMatchObject({
      "User-Agent": expect.stringContaining("Mozilla"),
      Accept: "application/json",
    });
  });

  it("parses comma-grouped prices exactly, e.g. $1,234.50", () => {
    expect(toMicroUsd("$1,234.50")).toBe(1_234_500_000n);
  });

  it("throws a typed SourceError on a non-200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, {}));

    await expect(
      fetchNasdaqQuote("AAPL", fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ name: "SourceError", status: 403 });
  });

  it("throws when data.primaryData is missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { symbol: "AAPL" } }));

    await expect(
      fetchNasdaqQuote("AAPL", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/primaryData/);
  });

  it.skipIf(process.env.LIVE_SOURCES !== "1")("live smoke test against the real Nasdaq API", async () => {
    const observation = await fetchNasdaqQuote("AAPL");
    expect(observation.priceMicro).toBeGreaterThan(0n);
  });

  it("throws when the response symbol does not match the requested ticker", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          symbol: "MSFT",
          primaryData: {
            lastSalePrice: "$333.41",
            lastTradeTimestamp: "Oct 6, 2026 2:54 PM ET",
            isRealTime: true,
          },
          marketStatus: "Open",
        },
      }),
    );

    await expect(
      fetchNasdaqQuote("AAPL", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/does not match/);
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("throws SourceError('timeout') when fetch never resolves within 5000ms", async () => {
      const fetchImpl = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));

      const pending = fetchNasdaqQuote("AAPL", fetchImpl as unknown as typeof fetch);
      const assertion = expect(pending).rejects.toMatchObject({ name: "SourceError", message: "timeout" });

      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    });
  });
});
