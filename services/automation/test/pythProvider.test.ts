import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { PythReceiverProvider, sendTransactionsInOrder, type TransactionSender } from "../src/providers/PythReceiverProvider";
import { closeTs } from "../src/calendar";
import { SourceError } from "../src/sources/types";

const BTC_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const AAPL_FEED_HEX = "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function mockChain(feedHex: string) {
  return {
    fetchConfig: vi.fn().mockResolvedValue({
      tickers: [{ symbol: "AAPL", feedId: hexToBytes(feedHex), enabled: true }],
    }),
  };
}

// Never actually constructed in these tests -- `connection`/`publisherKeypair`/
// `receiverProgramId` only need to be structurally valid since `postUpdate` is always
// injected, bypassing the real `PythSolanaReceiver`/network call.
function dummyConnection(): Connection {
  return new Connection("http://127.0.0.1:8899");
}

describe("PythReceiverProvider.publish", () => {
  it("resolves the feed id from on-chain Config, fetches Hermes, and posts via the injected postUpdate", async () => {
    const chain = mockChain(BTC_FEED_HEX);
    const fetchLatest = vi.fn().mockResolvedValue({
      binary: Uint8Array.from([9, 9, 9]),
      parsed: { price: 6_200_000_000_000n, conf: 500_000_000n, expo: -8, publishTime: 1_759_900_000 },
    });
    const priceAccount = Keypair.generate().publicKey;
    const postUpdate = vi.fn().mockResolvedValue({ priceAccount });

    const provider = new PythReceiverProvider({
      chain,
      connection: dummyConnection(),
      publisherKeypair: Keypair.generate(),
      receiverProgramId: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
      hermesBaseUrl: "https://pyth.dourolabs.app/hermes",
      pythApiKey: "test-key",
      fetchLatest,
      postUpdate,
    });

    const result = await provider.publish("AAPL");

    expect(chain.fetchConfig).toHaveBeenCalledTimes(1);
    expect(fetchLatest).toHaveBeenCalledWith(BTC_FEED_HEX, {
      baseUrl: "https://pyth.dourolabs.app/hermes",
      apiKey: "test-key",
    });
    expect(postUpdate).toHaveBeenCalledWith(Uint8Array.from([9, 9, 9]), BTC_FEED_HEX);
    expect(result.priceAccount).toBe(priceAccount);
    expect(result.publishTime).toBe(1_759_900_000);
  });

  it("throws when Config has no entry for the ticker", async () => {
    const chain = { fetchConfig: vi.fn().mockResolvedValue({ tickers: [] }) };

    const provider = new PythReceiverProvider({
      chain,
      connection: dummyConnection(),
      publisherKeypair: Keypair.generate(),
      receiverProgramId: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
      hermesBaseUrl: "https://pyth.dourolabs.app/hermes",
      pythApiKey: "test-key",
    });

    await expect(provider.publish("AAPL")).rejects.toThrow(/no entry for AAPL/);
  });
});

describe("PythReceiverProvider.previousClose", () => {
  // Monday 2026-10-12, 11:00 ET-ish (wall clock given as a plain UTC instant).
  const MONDAY_NOW = Math.floor(new Date("2026-10-12T15:00:00Z").getTime() / 1000);
  // Friday 2026-11-27 (the day after Thanksgiving), 10:00 ET.
  const FRIDAY_AFTER_THANKSGIVING_NOW = Math.floor(new Date("2026-11-27T15:00:00Z").getTime() / 1000);

  it("fix #3: Monday anchors on the previous Friday's close, not naive now-minus-24h", async () => {
    const chain = mockChain(AAPL_FEED_HEX);
    const previousFridayClose = closeTs(20261009);
    const fetchHistorical = vi.fn().mockResolvedValue({
      binary: Uint8Array.from([]),
      parsed: { price: 33_341_000_000n, conf: 1_000_000n, expo: -8, publishTime: previousFridayClose },
    });

    const provider = new PythReceiverProvider({
      chain,
      connection: dummyConnection(),
      publisherKeypair: Keypair.generate(),
      receiverProgramId: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
      hermesBaseUrl: "https://pyth.dourolabs.app/hermes",
      pythApiKey: "test-key",
      fetchHistorical,
      now: () => MONDAY_NOW,
    });

    const result = await provider.previousClose("AAPL");

    // 33_341_000_000 at expo -8 -> $333.41 -> 333_410_000 micro-USD.
    expect(result).toBe(333_410_000n);
    expect(fetchHistorical).toHaveBeenCalledWith(AAPL_FEED_HEX, previousFridayClose, {
      baseUrl: "https://pyth.dourolabs.app/hermes",
      apiKey: "test-key",
    });
  });

  it("fix #3: skips a NYSE holiday when walking back to the previous trading day", async () => {
    const chain = mockChain(AAPL_FEED_HEX);
    // 2026-11-26 (Thu) is Thanksgiving (a static NYSE holiday) -- the previous
    // trading day before Friday 11-27 must be Wednesday 11-25, not Thursday.
    const previousWednesdayClose = closeTs(20261125);
    const fetchHistorical = vi.fn().mockResolvedValue({
      binary: Uint8Array.from([]),
      parsed: { price: 33_341_000_000n, conf: 1_000_000n, expo: -8, publishTime: previousWednesdayClose },
    });

    const provider = new PythReceiverProvider({
      chain,
      connection: dummyConnection(),
      publisherKeypair: Keypair.generate(),
      receiverProgramId: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
      hermesBaseUrl: "https://pyth.dourolabs.app/hermes",
      pythApiKey: "test-key",
      fetchHistorical,
      now: () => FRIDAY_AFTER_THANKSGIVING_NOW,
    });

    await provider.previousClose("AAPL");

    expect(fetchHistorical).toHaveBeenCalledWith(AAPL_FEED_HEX, previousWednesdayClose, {
      baseUrl: "https://pyth.dourolabs.app/hermes",
      apiKey: "test-key",
    });
  });

  it("fix #3: falls back to Finnhub when Hermes's publish_time is more than 5 minutes from the expected close", async () => {
    const chain = mockChain(AAPL_FEED_HEX);
    const previousFridayClose = closeTs(20261009);
    // 10 minutes off the expected close -- outside the 5-minute tolerance.
    const fetchHistorical = vi.fn().mockResolvedValue({
      binary: Uint8Array.from([]),
      parsed: { price: 33_341_000_000n, conf: 1_000_000n, expo: -8, publishTime: previousFridayClose - 600 },
    });
    const fetchFinnhub = vi.fn().mockResolvedValue({
      current: { ticker: "AAPL", source: "finnhub", priceMicro: 333_000_000n, observedAt: 1 },
      previousClose: 330_000_000n,
      tradeTime: 1,
    });

    const provider = new PythReceiverProvider({
      chain,
      connection: dummyConnection(),
      publisherKeypair: Keypair.generate(),
      receiverProgramId: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
      hermesBaseUrl: "https://pyth.dourolabs.app/hermes",
      pythApiKey: "test-key",
      finnhubApiKey: "finnhub-key",
      fetchHistorical,
      fetchFinnhub,
      now: () => MONDAY_NOW,
    });

    const result = await provider.previousClose("AAPL");
    expect(result).toBe(330_000_000n);
    expect(fetchFinnhub).toHaveBeenCalledWith("AAPL", "finnhub-key");
  });

  it("falls back to Finnhub when the Hermes historical read fails", async () => {
    const chain = mockChain(AAPL_FEED_HEX);
    const fetchHistorical = vi.fn().mockRejectedValue(new SourceError("finnhub", "boom"));
    const fetchFinnhub = vi.fn().mockResolvedValue({
      current: { ticker: "AAPL", source: "finnhub", priceMicro: 333_000_000n, observedAt: 1 },
      previousClose: 330_000_000n,
      tradeTime: 1,
    });

    const provider = new PythReceiverProvider({
      chain,
      connection: dummyConnection(),
      publisherKeypair: Keypair.generate(),
      receiverProgramId: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
      hermesBaseUrl: "https://pyth.dourolabs.app/hermes",
      pythApiKey: "test-key",
      finnhubApiKey: "finnhub-key",
      fetchHistorical,
      fetchFinnhub,
      now: () => MONDAY_NOW,
    });

    const result = await provider.previousClose("AAPL");
    expect(result).toBe(330_000_000n);
    expect(fetchFinnhub).toHaveBeenCalledWith("AAPL", "finnhub-key");
  });

  it("throws when Hermes fails and no Finnhub fallback is configured", async () => {
    const chain = mockChain(AAPL_FEED_HEX);
    const fetchHistorical = vi.fn().mockRejectedValue(new Error("hermes down"));

    const provider = new PythReceiverProvider({
      chain,
      connection: dummyConnection(),
      publisherKeypair: Keypair.generate(),
      receiverProgramId: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
      hermesBaseUrl: "https://pyth.dourolabs.app/hermes",
      pythApiKey: "test-key",
      fetchHistorical,
      now: () => MONDAY_NOW,
    });

    await expect(provider.previousClose("AAPL")).rejects.toThrow(/no FINNHUB_API_KEY fallback/);
  });
});

describe("sendTransactionsInOrder", () => {
  function fakeTx(): VersionedTransaction {
    return { sign: vi.fn() } as unknown as VersionedTransaction;
  }

  it("fix #1: sends and confirms a mocked builder's two transactions in order", async () => {
    const tx1 = fakeTx();
    const tx2 = fakeTx();
    const signer1 = Keypair.generate();
    const signer2 = Keypair.generate();
    const publisherKeypair = Keypair.generate();

    const calls: string[] = [];
    const connection: TransactionSender = {
      sendTransaction: vi.fn(async (tx: VersionedTransaction) => {
        const which = tx === tx1 ? "1" : "2";
        calls.push(`send-${which}`);
        return `sig-${which}`;
      }),
      confirmTransaction: vi.fn(async (signature: string) => {
        calls.push(`confirm-${signature}`);
        return { value: { err: null } };
      }),
    };

    await sendTransactionsInOrder(connection, publisherKeypair, [
      { tx: tx1, signers: [signer1] },
      { tx: tx2, signers: [signer2] },
    ]);

    // Fix #1: two transactions from the mocked builder, sent and confirmed strictly in
    // order -- never both in flight at once.
    expect(calls).toEqual(["send-1", "confirm-sig-1", "send-2", "confirm-sig-2"]);
    expect(tx1.sign).toHaveBeenCalledWith([publisherKeypair, signer1]);
    expect(tx2.sign).toHaveBeenCalledWith([publisherKeypair, signer2]);
  });

  it("fix #6: throws on a confirmed-but-failed transaction and never sends the next one", async () => {
    const tx1 = fakeTx();
    const tx2 = fakeTx();
    const publisherKeypair = Keypair.generate();

    const sendTransaction = vi.fn().mockResolvedValueOnce("sig-1").mockResolvedValueOnce("sig-2");
    const confirmTransaction = vi.fn().mockResolvedValueOnce({ value: { err: { InstructionError: [0, "boom"] } } });
    const connection: TransactionSender = { sendTransaction, confirmTransaction };

    await expect(
      sendTransactionsInOrder(connection, publisherKeypair, [
        { tx: tx1, signers: [] },
        { tx: tx2, signers: [] },
      ]),
    ).rejects.toThrow(/confirmed with an error/);

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(confirmTransaction).toHaveBeenCalledTimes(1);
  });
});
