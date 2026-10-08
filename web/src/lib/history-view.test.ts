import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ONE_USDC, Side, type MeridianEvent } from "@meridian/sdk";
import { buildHistoryEntries } from "./history-view";

const wallet = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const market = Keypair.generate().publicKey;

function ev<N extends MeridianEvent["name"]>(name: N, signature: string, data: Extract<MeridianEvent, { name: N }>["data"], ts = 1): MeridianEvent {
  return { name, data, signature, slot: 1, ts } as MeridianEvent;
}

function fill(signature: string, taker: PublicKey, maker: PublicKey, sideOfTaker: Side, price: bigint, qty: bigint, ts = 1): MeridianEvent {
  return ev("Fill", signature, { market, makerOrderId: 1n, maker, taker, sideOfTaker, price, qty, ts: BigInt(ts) }, ts);
}

describe("buildHistoryEntries", () => {
  it("collapses buy_no_market (mint + sell Yes + redeem leftovers) into one Bought No row at the No price", () => {
    const entries = buildHistoryEntries(
      [
        ev("Minted", "sig1", { market, user: wallet, qty: 4n }),
        fill("sig1", wallet, other, Side.Ask, 600_000n, 3n),
        ev("PairRedeemed", "sig1", { market, user: wallet, qty: 1n }),
      ],
      wallet,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Bought No");
    expect(entries[0].amountMicro).toBe(400_000n * 3n);
  });

  it("collapses sell_no_market (buy Yes + redeem pairs) into one Sold No row", () => {
    const entries = buildHistoryEntries(
      [fill("sig2", wallet, other, Side.Bid, 600_000n, 2n), ev("PairRedeemed", "sig2", { market, user: wallet, qty: 2n })],
      wallet,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Sold No");
    expect(entries[0].amountMicro).toBe(400_000n * 2n);
  });

  it("shows a resting limit bid as a Placed order row for the unfilled part", () => {
    const entries = buildHistoryEntries(
      [
        ev("OrderPlaced", "sig3", { market, orderId: 7n, owner: wallet, side: Side.Bid, price: 500_000n, qty: 3n }),
        fill("sig3", wallet, other, Side.Bid, 500_000n, 1n),
      ],
      wallet,
    );
    expect(entries.map((e) => e.label).sort()).toEqual(["Bought Yes", "Placed order: Buy Yes at $0.50"]);
    const placed = entries.find((e) => e.kind === "order")!;
    expect(placed.amountMicro).toBe(500_000n * 2n);
  });

  it("shows buy_no_limit (mint + resting ask) as a No-side placed order", () => {
    const entries = buildHistoryEntries(
      [
        ev("Minted", "sig4", { market, user: wallet, qty: 5n }),
        ev("OrderPlaced", "sig4", { market, orderId: 8n, owner: wallet, side: Side.Ask, price: 700_000n, qty: 5n }),
      ],
      wallet,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Placed order: Buy No at $0.30");
    expect(entries[0].amountMicro).toBe(5n * ONE_USDC);
  });

  it("keeps a plain mint, a maker-side fill, and a cancel as separate rows", () => {
    const entries = buildHistoryEntries(
      [
        ev("Minted", "sig5", { market, user: wallet, qty: 2n }, 1),
        fill("sig6", other, wallet, Side.Bid, 600_000n, 1n, 2),
        ev("OrderPlaced", "sig7", { market, orderId: 9n, owner: wallet, side: Side.Bid, price: 400_000n, qty: 1n }, 3),
        ev("OrderCancelled", "sig8", { market, orderId: 9n, owner: wallet, remainingRefunded: 400_000n }, 4),
      ],
      wallet,
    );
    expect(entries.map((e) => e.label)).toEqual([
      "Cancelled order",
      "Placed order: Buy Yes at $0.40",
      "Sold Yes",
      "Minted pair",
    ]);
  });

  it("ignores events for other wallets", () => {
    expect(buildHistoryEntries([ev("Minted", "sig9", { market, user: other, qty: 2n })], wallet)).toEqual([]);
  });
});
