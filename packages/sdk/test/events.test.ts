import { PROGRAM_ID } from "../src/index";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  encodeEventForTest,
  fetchWalletEvents,
  parseEventsFromLogs,
  parseEventsFromTransaction,
  type FillData,
  type MarketCreatedData,
  type MeridianEvent,
  type MintedData,
  type OrderCancelledData,
  type OrderPlacedData,
  type PairRedeemedData,
  type PausedData,
  type SettledData,
  type UnpausedData,
  type WinningRedeemedData,
} from "../src/events";
import { Side } from "../src/types";

const SIGNATURE = "5TestSignature11111111111111111111111111111111111111111111111";
const SLOT = 123456;

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

/** Wraps `encodeEventForTest`'s single log line as a minimal, realistic log array. */
function wrapLog(line: string): string[] {
  return [
    `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
    line,
    `Program ${PROGRAM_ID.toBase58()} success`,
  ];
}

describe("parseEventsFromLogs / encodeEventForTest round trip", () => {
  it("round-trips MarketCreated with exact bigint/PublicKey equality", () => {
    const data: MarketCreatedData = {
      market: pk(1),
      ticker: "AAPL",
      strike: 150_000_000n,
      tradingDay: 20260106,
      closeTs: 1_767_700_800n,
    };
    const log = encodeEventForTest("MarketCreated", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT);
    expect(event.name).toBe("MarketCreated");
    expect(event.signature).toBe(SIGNATURE);
    expect(event.slot).toBe(SLOT);
    const got = event.data as MarketCreatedData;
    expect(got.market.equals(data.market)).toBe(true);
    expect(got.ticker).toBe(data.ticker);
    expect(got.strike).toBe(data.strike);
    expect(got.tradingDay).toBe(data.tradingDay);
    expect(got.closeTs).toBe(data.closeTs);
  });

  it("round-trips Minted", () => {
    const data: MintedData = { market: pk(2), user: pk(3), qty: 10n };
    const log = encodeEventForTest("Minted", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT);
    expect(event).toMatchObject({ name: "Minted", signature: SIGNATURE, slot: SLOT });
    const got = event.data as MintedData;
    expect(got.market.equals(data.market)).toBe(true);
    expect(got.user.equals(data.user)).toBe(true);
    expect(got.qty).toBe(10n);
  });

  it("round-trips PairRedeemed", () => {
    const data: PairRedeemedData = { market: pk(4), user: pk(5), qty: 7n };
    const log = encodeEventForTest("PairRedeemed", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT);
    const got = event.data as PairRedeemedData;
    expect(event.name).toBe("PairRedeemed");
    expect(got.market.equals(data.market)).toBe(true);
    expect(got.user.equals(data.user)).toBe(true);
    expect(got.qty).toBe(7n);
  });

  it("round-trips OrderPlaced", () => {
    const data: OrderPlacedData = {
      market: pk(6),
      orderId: 42n,
      owner: pk(7),
      side: Side.Bid,
      price: 650_000n,
      qty: 3n,
    };
    const log = encodeEventForTest("OrderPlaced", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT);
    const got = event.data as OrderPlacedData;
    expect(event.name).toBe("OrderPlaced");
    expect(got.market.equals(data.market)).toBe(true);
    expect(got.orderId).toBe(42n);
    expect(got.owner.equals(data.owner)).toBe(true);
    expect(got.side).toBe(Side.Bid);
    expect(got.price).toBe(650_000n);
    expect(got.qty).toBe(3n);
  });

  it("round-trips OrderCancelled", () => {
    const data: OrderCancelledData = { market: pk(8), orderId: 99n, owner: pk(9), remainingRefunded: 2n };
    const log = encodeEventForTest("OrderCancelled", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT);
    const got = event.data as OrderCancelledData;
    expect(event.name).toBe("OrderCancelled");
    expect(got.orderId).toBe(99n);
    expect(got.remainingRefunded).toBe(2n);
  });

  it("round-trips Fill, including negative-looking i64 ts handled as plain bigint", () => {
    const data: FillData = {
      market: pk(10),
      makerOrderId: 11n,
      maker: pk(11),
      taker: pk(12),
      sideOfTaker: Side.Ask,
      price: 400_000n,
      qty: 5n,
      ts: 1_767_700_815n,
    };
    const log = encodeEventForTest("Fill", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT);
    const got = event.data as FillData;
    expect(event.name).toBe("Fill");
    expect(got.makerOrderId).toBe(11n);
    expect(got.maker.equals(data.maker)).toBe(true);
    expect(got.taker.equals(data.taker)).toBe(true);
    expect(got.sideOfTaker).toBe(Side.Ask);
    expect(got.price).toBe(400_000n);
    expect(got.qty).toBe(5n);
    expect(got.ts).toBe(1_767_700_815n);
  });

  it("round-trips Settled", () => {
    const data: SettledData = { market: pk(13), price: 151_200_000n, outcome: 1, byOverride: false, ts: 1_767_700_900n };
    const log = encodeEventForTest("Settled", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT);
    const got = event.data as SettledData;
    expect(event.name).toBe("Settled");
    expect(got.price).toBe(151_200_000n);
    expect(got.outcome).toBe(1);
    expect(got.byOverride).toBe(false);
    expect(got.ts).toBe(1_767_700_900n);
  });

  it("round-trips Settled with byOverride true", () => {
    const data: SettledData = { market: pk(14), price: 99_000_000n, outcome: 2, byOverride: true, ts: 1_767_704_500n };
    const log = encodeEventForTest("Settled", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT);
    const got = event.data as SettledData;
    expect(got.outcome).toBe(2);
    expect(got.byOverride).toBe(true);
  });

  it("round-trips WinningRedeemed", () => {
    const data: WinningRedeemedData = { market: pk(15), user: pk(16), side: 1, qty: 5n, payout: 5_000_000n };
    const log = encodeEventForTest("WinningRedeemed", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT);
    const got = event.data as WinningRedeemedData;
    expect(event.name).toBe("WinningRedeemed");
    expect(got.side).toBe(1);
    expect(got.qty).toBe(5n);
    expect(got.payout).toBe(5_000_000n);
  });

  it("round-trips Paused and Unpaused", () => {
    const paused: PausedData = { admin: pk(17), ts: 1_767_700_000n };
    const unpaused: UnpausedData = { admin: pk(18), ts: 1_767_701_000n };
    const [pausedEvent] = parseEventsFromLogs(wrapLog(encodeEventForTest("Paused", paused)), SIGNATURE, SLOT);
    const [unpausedEvent] = parseEventsFromLogs(wrapLog(encodeEventForTest("Unpaused", unpaused)), SIGNATURE, SLOT);
    expect(pausedEvent.name).toBe("Paused");
    expect((pausedEvent.data as PausedData).admin.equals(paused.admin)).toBe(true);
    expect((pausedEvent.data as PausedData).ts).toBe(1_767_700_000n);
    expect(unpausedEvent.name).toBe("Unpaused");
    expect((unpausedEvent.data as UnpausedData).ts).toBe(1_767_701_000n);
  });

  it("carries the optional ts through parseEventsFromLogs when given", () => {
    const data: MintedData = { market: pk(19), user: pk(20), qty: 1n };
    const log = encodeEventForTest("Minted", data);
    const [event] = parseEventsFromLogs(wrapLog(log), SIGNATURE, SLOT, 1_767_700_000);
    expect(event.ts).toBe(1_767_700_000);
  });

  it("ignores an unrelated program's 'Program data:' line", () => {
    const logs = [
      `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
      "Program data: bm90LWEtcmVhbC1ldmVudA==", // base64 of "not-a-real-event", no matching discriminator
      `Program ${PROGRAM_ID.toBase58()} success`,
    ];
    const events: MeridianEvent[] = parseEventsFromLogs(logs, SIGNATURE, SLOT);
    expect(events).toHaveLength(0);
  });

  it("ignores a non-base64 'Program data:' line without throwing", () => {
    const logs = ["Program data: not-valid-base64!!!"];
    expect(() => parseEventsFromLogs(logs, SIGNATURE, SLOT)).not.toThrow();
    expect(parseEventsFromLogs(logs, SIGNATURE, SLOT)).toHaveLength(0);
  });

  it("decodes multiple events out of one log array, in order", () => {
    const minted: MintedData = { market: pk(21), user: pk(22), qty: 1n };
    const redeemed: PairRedeemedData = { market: pk(21), user: pk(22), qty: 1n };
    const logs = [
      `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
      encodeEventForTest("Minted", minted),
      encodeEventForTest("PairRedeemed", redeemed),
      `Program ${PROGRAM_ID.toBase58()} success`,
    ];
    const events = parseEventsFromLogs(logs, SIGNATURE, SLOT);
    expect(events.map((e) => e.name)).toEqual(["Minted", "PairRedeemed"]);
  });

  it("ignores a 'Program data:' line emitted under another program's nested invocation", () => {
    const otherProgram = pk(50).toBase58();
    const minted: MintedData = { market: pk(23), user: pk(24), qty: 9n };
    const logs = [
      `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
      `Program ${otherProgram} invoke [2]`,
      // Even though this line decodes cleanly against our IDL, it was
      // emitted while `otherProgram` was executing (CPI), not us.
      encodeEventForTest("Minted", minted),
      `Program ${otherProgram} success`,
      `Program ${PROGRAM_ID.toBase58()} success`,
    ];
    const events = parseEventsFromLogs(logs, SIGNATURE, SLOT);
    expect(events).toHaveLength(0);
  });

  it("parseEventsFromTransaction yields no events for a failed transaction", () => {
    const minted: MintedData = { market: pk(25), user: pk(26), qty: 2n };
    const logs = [
      `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
      encodeEventForTest("Minted", minted),
      `Program ${PROGRAM_ID.toBase58()} success`,
    ];
    const tx = {
      transaction: { signatures: [SIGNATURE] },
      slot: SLOT,
      blockTime: null,
      meta: { err: { InstructionError: [0, "Custom"] }, logMessages: logs },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(parseEventsFromTransaction(tx)).toHaveLength(0);
  });
});

describe("fetchWalletEvents", () => {
  it("finds a maker fill even though the maker's wallet never appears in its own getSignaturesForAddress", async () => {
    const programId = pk(60);
    const market = pk(61);
    const maker = pk(62);
    const taker = pk(63);
    const fillData: FillData = {
      market,
      makerOrderId: 1n,
      maker,
      taker,
      sideOfTaker: Side.Ask,
      price: 500_000n,
      qty: 1n,
      ts: 0n,
    };
    const logs = [
      `Program ${programId.toBase58()} invoke [1]`,
      encodeEventForTest("Fill", fillData),
      `Program ${programId.toBase58()} success`,
    ];
    const tx = {
      transaction: { signatures: ["sig-1"] },
      slot: 1,
      blockTime: null,
      meta: { err: null, logMessages: logs },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // `fetchProgramEvents` (which `fetchWalletEvents` wraps) pages
    // `getSignaturesForAddress(programId)`, not the wallet -- this fake
    // connection only serves that program-keyed page, proving the maker's
    // Fill is still found purely by field-matching `maker` in the event data.
    const connection = {
      getSignaturesForAddress: async (_address: PublicKey, _opts: unknown) => [{ signature: "sig-1" }],
      getParsedTransaction: async (_sig: string, _opts: unknown) => tx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const events = await fetchWalletEvents(connection, programId, maker);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("Fill");
  });
});
