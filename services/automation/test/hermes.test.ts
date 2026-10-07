import { describe, expect, it, vi } from "vitest";
import { fetchHistoricalUpdate, fetchLatestUpdate, HermesError } from "../src/sources/hermes";

const BTC_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const AAPL_FEED = "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688";

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return { status, text: async () => text } as unknown as Response;
}

function rawResponse(status: number, body: string): Response {
  return { status, text: async () => body } as unknown as Response;
}

const RAW_UPDATE_BYTES = Uint8Array.from([1, 2, 3, 4]);
const RAW_UPDATE_B64 = Buffer.from(RAW_UPDATE_BYTES).toString("base64");

function cannedBody(overrides: Partial<{ price: string; conf: string; expo: number; publish_time: number }> = {}) {
  return {
    binary: { encoding: "base64", data: [RAW_UPDATE_B64] },
    parsed: [
      {
        id: BTC_FEED,
        price: {
          price: overrides.price ?? "6200000000000",
          conf: overrides.conf ?? "500000000",
          expo: overrides.expo ?? -8,
          publish_time: overrides.publish_time ?? 1_759_900_000,
        },
      },
    ],
  };
}

describe("fetchLatestUpdate", () => {
  it("parses the happy path and decodes the binary update", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, cannedBody()));

    const result = await fetchLatestUpdate(BTC_FEED, {
      baseUrl: "https://pyth.dourolabs.app/hermes",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.binary).toEqual(RAW_UPDATE_BYTES);
    expect(result.parsed.price).toBe(6_200_000_000_000n);
    expect(result.parsed.conf).toBe(500_000_000n);
    expect(result.parsed.expo).toBe(-8);
    expect(result.parsed.publishTime).toBe(1_759_900_000);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://pyth.dourolabs.app/hermes/v2/updates/price/latest?ids[]=${BTC_FEED}&encoding=base64&parsed=true`,
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("throws a typed HermesError carrying status and body on 403 Not entitled", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(rawResponse(403, `Not entitled: feed ${AAPL_FEED} requires an upgraded plan`));

    await expect(
      fetchLatestUpdate(AAPL_FEED, {
        baseUrl: "https://pyth.dourolabs.app/hermes",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "HermesError",
      status: 403,
      body: `Not entitled: feed ${AAPL_FEED} requires an upgraded plan`,
    });
  });

  it("throws a typed HermesError on 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rawResponse(401, "Unauthorized"));

    await expect(
      fetchLatestUpdate(BTC_FEED, {
        baseUrl: "https://pyth.dourolabs.app/hermes",
        apiKey: "bad-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(HermesError);
  });

  it("throws a typed HermesError on 429 without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rawResponse(429, "Too Many Requests"));

    await expect(
      fetchLatestUpdate(BTC_FEED, {
        baseUrl: "https://pyth.dourolabs.app/hermes",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 429 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fix #5: keeps the 5s deadline active through body consumption (a stalled body still times out)", async () => {
    vi.useFakeTimers();
    try {
      // Headers arrive immediately, but `.text()` never resolves -- simulates a
      // connection that stalls mid-body rather than failing outright.
      const stallingResponse = { status: 200, text: () => new Promise<string>(() => {}) } as unknown as Response;
      const fetchImpl = vi.fn().mockResolvedValue(stallingResponse);

      const promise = fetchLatestUpdate(BTC_FEED, {
        baseUrl: "https://pyth.dourolabs.app/hermes",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const assertion = expect(promise).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws a plain Error when binary.data is missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { parsed: cannedBody().parsed }));

    await expect(
      fetchLatestUpdate(BTC_FEED, {
        baseUrl: "https://pyth.dourolabs.app/hermes",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/binary\.data/);
  });
});

describe("fetchHistoricalUpdate", () => {
  it("requests the unix-timestamped historical endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, cannedBody()));

    await fetchHistoricalUpdate(BTC_FEED, 1_759_800_000, {
      baseUrl: "https://pyth.dourolabs.app/hermes",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://pyth.dourolabs.app/hermes/v2/updates/price/1759800000?ids[]=${BTC_FEED}&encoding=base64&parsed=true`,
    );
  });
});
