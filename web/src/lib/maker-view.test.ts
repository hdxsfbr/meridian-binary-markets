import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { Book, Order } from "@meridian/sdk";
import {
  buildMyOrderRows,
  exposureForStrike,
  groupMyOrderRows,
  lockedForAsk,
  lockedForBid,
  restingTotalsByMarket,
  sortMyOrderRows,
  type MarketMeta,
  type MyOrderRow,
} from "./maker-view";

function pk(seed: string): PublicKey {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < seed.length; i += 1) {
    bytes[i % 32] ^= seed.charCodeAt(i);
  }
  return new PublicKey(bytes);
}

const WALLET = pk("wallet");
const OTHER = pk("other");

function order(overrides: Partial<Order> & { owner: PublicKey }): Order {
  return { id: 1n, price: 500_000n, remaining: 10n, seq: 1n, ...overrides };
}

function book(bids: Order[], asks: Order[]): Book {
  return {
    header: {
      market: pk("market"),
      usdcEscrow: pk("usdc-escrow"),
      yesEscrow: pk("yes-escrow"),
      nextOrderId: 10n,
      nextSeq: 10n,
      capacity: 16,
      bidCount: bids.length,
      askCount: asks.length,
    },
    bids,
    asks,
  };
}

function meta(overrides: Partial<MarketMeta> & { pubkey: PublicKey }): MarketMeta {
  return {
    ticker: "META",
    strike: 680_000_000n,
    tradingDay: 20261006,
    closeTs: 1_000n,
    state: "open",
    ...overrides,
  };
}

describe("lockedForBid / lockedForAsk", () => {
  it("locks price * remaining micro-USDC for a bid", () => {
    expect(lockedForBid(650_000n, 4n)).toBe(2_600_000n);
  });

  it("locks the remaining Yes quantity itself for an ask (no dollar conversion)", () => {
    expect(lockedForAsk(7n)).toBe(7n);
  });
});

describe("exposureForStrike", () => {
  it("is yes - no", () => {
    expect(exposureForStrike(10n, 3n)).toBe(7n);
    expect(exposureForStrike(2n, 9n)).toBe(-7n);
    expect(exposureForStrike(5n, 5n)).toBe(0n);
  });
});

describe("buildMyOrderRows", () => {
  it("collects only the wallet's own bids and asks, with the right locked amounts", () => {
    const m = pk("m1");
    const markets = [meta({ pubkey: m })];
    const books = new Map([
      [
        m.toBase58(),
        book(
          [order({ id: 1n, owner: WALLET, price: 600_000n, remaining: 3n }), order({ id: 2n, owner: OTHER, price: 610_000n, remaining: 5n })],
          [order({ id: 3n, owner: WALLET, price: 700_000n, remaining: 4n })],
        ),
      ],
    ]);

    const rows = buildMyOrderRows(markets, books, WALLET);

    expect(rows).toHaveLength(2);
    const bid = rows.find((r) => r.side === "bid");
    const ask = rows.find((r) => r.side === "ask");
    expect(bid?.orderId).toBe(1n);
    expect(bid?.lockedUsdcMicro).toBe(1_800_000n); // 600_000 * 3
    expect(bid?.lockedYesQty).toBeUndefined();
    expect(ask?.orderId).toBe(3n);
    expect(ask?.lockedYesQty).toBe(4n);
    expect(ask?.lockedUsdcMicro).toBeUndefined();
  });

  it("skips markets with no book fetched yet", () => {
    const m = pk("m2");
    const markets = [meta({ pubkey: m })];
    const rows = buildMyOrderRows(markets, new Map(), WALLET);
    expect(rows).toEqual([]);
  });

  it("returns nothing for a book with no orders from this wallet", () => {
    const m = pk("m3");
    const markets = [meta({ pubkey: m })];
    const books = new Map([[m.toBase58(), book([order({ owner: OTHER })], [])]]);
    expect(buildMyOrderRows(markets, books, WALLET)).toEqual([]);
  });
});

function row(overrides: Partial<MyOrderRow> & { marketKey: string }): MyOrderRow {
  return {
    market: pk(overrides.marketKey),
    ticker: "META",
    strike: 680_000_000n,
    tradingDay: 20261006,
    closeTs: 1_000n,
    state: "open",
    side: "bid",
    orderId: 1n,
    price: 500_000n,
    remaining: 1n,
    ...overrides,
  };
}

describe("sortMyOrderRows", () => {
  it("orders most-recent trading day first, then ticker, then strike, then bid before ask, then price", () => {
    const rows: MyOrderRow[] = [
      row({ marketKey: "a", tradingDay: 20261005, ticker: "META", strike: 680_000_000n, side: "bid", price: 600_000n }),
      row({ marketKey: "b", tradingDay: 20261006, ticker: "AAPL", strike: 200_000_000n, side: "ask", price: 300_000n }),
      row({ marketKey: "c", tradingDay: 20261006, ticker: "META", strike: 670_000_000n, side: "bid", price: 500_000n }),
      row({ marketKey: "d", tradingDay: 20261006, ticker: "META", strike: 670_000_000n, side: "ask", price: 550_000n }),
    ];

    const sorted = sortMyOrderRows(rows);
    expect(sorted.map((r) => r.marketKey)).toEqual(["b", "c", "d", "a"]);
  });

  it("does not mutate its input", () => {
    const rows: MyOrderRow[] = [row({ marketKey: "a", tradingDay: 1 }), row({ marketKey: "b", tradingDay: 2 })];
    const copy = [...rows];
    sortMyOrderRows(rows);
    expect(rows).toEqual(copy);
  });
});

describe("groupMyOrderRows", () => {
  it("groups by trading day then ticker, preserving sorted order within each group", () => {
    const rows: MyOrderRow[] = [
      row({ marketKey: "a", tradingDay: 20261006, ticker: "META", strike: 680_000_000n }),
      row({ marketKey: "b", tradingDay: 20261006, ticker: "META", strike: 670_000_000n }),
      row({ marketKey: "c", tradingDay: 20261006, ticker: "AAPL", strike: 200_000_000n }),
      row({ marketKey: "d", tradingDay: 20261005, ticker: "META", strike: 680_000_000n }),
    ];

    const groups = groupMyOrderRows(rows);

    expect(groups.map((g) => [g.tradingDay, g.ticker])).toEqual([
      [20261006, "AAPL"],
      [20261006, "META"],
      [20261005, "META"],
    ]);
    expect(groups.find((g) => g.ticker === "META" && g.tradingDay === 20261006)?.rows.map((r) => r.marketKey)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("restingTotalsByMarket", () => {
  it("sums quantity and escrow per side, keyed by market", () => {
    const rows: MyOrderRow[] = [
      row({ marketKey: "a", side: "bid", remaining: 3n, price: 600_000n, lockedUsdcMicro: 1_800_000n }),
      row({ marketKey: "a", side: "bid", remaining: 2n, price: 650_000n, lockedUsdcMicro: 1_300_000n }),
      row({ marketKey: "a", side: "ask", remaining: 4n, lockedYesQty: 4n }),
      row({ marketKey: "b", side: "ask", remaining: 1n, lockedYesQty: 1n }),
    ];

    const totals = restingTotalsByMarket(rows);

    expect(totals.get("a")).toEqual({ bidQty: 5n, askQty: 4n, lockedUsdcMicro: 3_100_000n, lockedYesQty: 4n });
    expect(totals.get("b")).toEqual({ bidQty: 0n, askQty: 1n, lockedUsdcMicro: 0n, lockedYesQty: 1n });
  });

  it("returns an empty map for no rows", () => {
    expect(restingTotalsByMarket([])).toEqual(new Map());
  });
});
