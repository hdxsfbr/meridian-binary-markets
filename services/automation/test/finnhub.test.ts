import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetFinnhubRateBudget, fetchFinnhubQuote } from "../src/sources/finnhub";
import { SourceError } from "../src/sources/types";

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

function rawResponse(status: number, rawBody: string): Response {
  return {
    status,
    text: async () => rawBody,
    json: async () => JSON.parse(rawBody),
  } as unknown as Response;
}

beforeEach(() => {
  __resetFinnhubRateBudget();
});

describe("fetchFinnhubQuote", () => {
  it("parses the happy path from a canned Finnhub response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { c: 333.41, pc: 330.0, t: 1_759_762_440 }));

    const result = await fetchFinnhubQuote("AAPL", "test-key", fetchImpl as unknown as typeof fetch);

    expect(result.current.ticker).toBe("AAPL");
    expect(result.current.source).toBe("finnhub");
    expect(result.current.priceMicro).toBe(333_410_000n);
    expect(result.current.observedAt).toBe(1_759_762_440);
    expect(result.previousClose).toBe(330_000_000n);
    expect(result.tradeTime).toBe(1_759_762_440);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://finnhub.io/api/v1/quote?symbol=AAPL&token=test-key",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("throws a typed SourceError with status on a non-200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}));

    await expect(
      fetchFinnhubQuote("AAPL", "bad-key", fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ name: "SourceError", status: 401 });
  });

  it("throws when c === 0 (no data)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { c: 0, pc: 330.0, t: 1_759_762_440 }));

    await expect(
      fetchFinnhubQuote("AAPL", "test-key", fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(SourceError);
  });

  it("trips the rate budget on the 61st call within a minute", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { c: 1, pc: 1, t: 1 }));

    for (let i = 0; i < 60; i += 1) {
      await fetchFinnhubQuote("AAPL", "test-key", fetchImpl as unknown as typeof fetch);
    }

    await expect(
      fetchFinnhubQuote("AAPL", "test-key", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/rate budget exhausted/);

    // The 61st attempt must not have called fetch at all.
    expect(fetchImpl).toHaveBeenCalledTimes(60);
  });

  it("extracts exact micro values from raw JSON text, never via a float parse", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(rawResponse(200, '{"c":333.41,"pc":332.89,"t":1791316800}'));

    const result = await fetchFinnhubQuote("AAPL", "test-key", fetchImpl as unknown as typeof fetch);

    expect(result.current.priceMicro).toBe(333_410_000n);
    expect(result.previousClose).toBe(332_890_000n);
    expect(result.tradeTime).toBe(1_791_316_800);
  });

  it("extracts a 4-decimal price exactly", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(rawResponse(200, '{"c":333.4123,"pc":332.89,"t":1791316800}'));

    const result = await fetchFinnhubQuote("AAPL", "test-key", fetchImpl as unknown as typeof fetch);

    expect(result.current.priceMicro).toBe(333_412_300n);
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

      const pending = fetchFinnhubQuote("AAPL", "test-key", fetchImpl as unknown as typeof fetch);
      const assertion = expect(pending).rejects.toMatchObject({ name: "SourceError", message: "timeout" });

      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    });
  });
});
