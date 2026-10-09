import { describe, expect, it } from "vitest";
import * as TradeCopy from "./trade-copy";
import {
  ACTION_LABEL,
  BOOK_FULL,
  CANCEL,
  CANCELLING,
  CLOSE_NO_FIRST,
  CLOSE_YES_FIRST,
  CONNECT_WALLET,
  INVALID_INPUT,
  KIND_LABEL,
  MARKET_SETTLED,
  MARKET_CLOSED,
  MINTED_PAIR,
  NO_HELD_YES_RESTING,
  NO_LIQUIDITY,
  ORDER_COULD_NOT_BE_PLACED,
  REDEEM_IN_PORTFOLIO,
  SENDING,
  SETTLEMENT_PENDING,
  TRADING_PAUSED,
  closeButtonLabel,
  estimateLabel,
  guidanceCopy,
  limitOrderToastDetail,
  limitOrderToastTitle,
  lockedUntilFilledLabel,
  marketOrderToastTitle,
  NOTHING_TRADED,
  ORDER_CONFIRMED_FALLBACK,
  programErrorCopy,
  quotesCancelledToastTitle,
  quotesPlacedToastTitle,
  redeemAllCollectedToastTitle,
  redeemCollectedToastTitle,
  settledOutcomeCopy,
  stillOpenFragment,
  winIfRightLabel,
} from "./trade-copy";

const FORBIDDEN_WORDS = [
  "mock",
  "provider",
  "pyth",
  "simulated",
  "todo",
  "stub",
  "placeholder",
  "coming soon",
  "resting",
  "fill",
  "filled",
  "escrow",
  "devnet",
  "rpc",
  "pda",
  "ata",
  "signature",
];

function allStaticStrings(): string[] {
  return [
    ...Object.values(ACTION_LABEL),
    ...Object.values(KIND_LABEL),
    CONNECT_WALLET,
    TRADING_PAUSED,
    SETTLEMENT_PENDING,
    MINTED_PAIR,
    NO_HELD_YES_RESTING,
    REDEEM_IN_PORTFOLIO,
    CLOSE_NO_FIRST,
    CLOSE_YES_FIRST,
    NO_LIQUIDITY,
    INVALID_INPUT,
    ORDER_COULD_NOT_BE_PLACED,
    BOOK_FULL,
    MARKET_SETTLED,
    SENDING,
    CANCEL,
    CANCELLING,
    NOTHING_TRADED,
    ORDER_CONFIRMED_FALLBACK,
  ];
}

function allDynamicStrings(): string[] {
  return [
    guidanceCopy("closeNoFirst"),
    guidanceCopy("closeYesFirst"),
    guidanceCopy("noLiquidity"),
    guidanceCopy("invalid"),
    programErrorCopy("Paused"),
    programErrorCopy("BookFull"),
    programErrorCopy("InsufficientFill"),
    programErrorCopy("MarketSettled"),
    programErrorCopy("WrongSide"),
    programErrorCopy(undefined),
    programErrorCopy("SomeUnknownError"),
    estimateLabel(1_000_000n),
    estimateLabel(-1_000_000n),
    estimateLabel(650_000n),
    winIfRightLabel(3n),
    settledOutcomeCopy("yes", 680_000_000n),
    settledOutcomeCopy("no", 1_234_560n),
    closeButtonLabel("closeNoFirst"),
    closeButtonLabel("closeYesFirst"),
    marketOrderToastTitle("buyYes", "AAPL", 345_000_000n, 2n, 1_100_000n),
    marketOrderToastTitle("sellNo", "AAPL", 345_000_000n, 2n, 900_000n),
    limitOrderToastTitle("buyYes", "AAPL", 345_000_000n, 2n, 550_000n),
    limitOrderToastDetail("buyYes", 1_100_000n, 2n),
    limitOrderToastDetail("sellYes", 0n, 2n),
    quotesPlacedToastTitle("AAPL", 345_000_000n, [
      { side: "ask", priceMicro: 550_000n, qty: 2n },
      { side: "bid", priceMicro: 450_000n, qty: 2n },
    ]),
    quotesCancelledToastTitle(1),
    quotesCancelledToastTitle(3),
    redeemCollectedToastTitle(2_000_000n, "AAPL", 345_000_000n),
    redeemAllCollectedToastTitle(5_000_000n, 3),
    stillOpenFragment("buyYes", 1n, 550_000n),
    stillOpenFragment("sellNo", 3n, 450_000n),
  ];
}

describe("trade-copy: no forbidden words in any user-facing string", () => {
  it("static strings", () => {
    for (const s of allStaticStrings()) {
      for (const word of FORBIDDEN_WORDS) {
        expect(s.toLowerCase()).not.toContain(word);
      }
    }
  });

  it("dynamic/formatted strings", () => {
    for (const s of allDynamicStrings()) {
      for (const word of FORBIDDEN_WORDS) {
        expect(s.toLowerCase()).not.toContain(word);
      }
    }
  });
});

/**
 * Global rule (CLAUDE.md): UI copy is for the end user, never implementation
 * commentary. This scans every exported *string* constant of the module
 * (including the values inside `ACTION_LABEL`/`KIND_LABEL`) for words that
 * would leak the on-chain/matching-engine plumbing into product copy, so a
 * future addition can't reintroduce one without failing a test.
 */
const UI_IMPLEMENTATION_WORDS = ["resting", "fill", "filled", "escrow", "mock", "devnet", "rpc", "pda"];

function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") {
    acc.push(value);
  } else if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) {
      collectStrings(nested, acc);
    }
  }
  return acc;
}

describe("trade-copy: no implementation commentary in any exported string constant", () => {
  it("scans every exported constant (string or record-of-strings) for forbidden words", () => {
    const strings = Object.entries(TradeCopy)
      .filter(([, value]) => typeof value !== "function")
      .flatMap(([, value]) => collectStrings(value));
    expect(strings.length).toBeGreaterThan(0);
    for (const s of strings) {
      for (const word of UI_IMPLEMENTATION_WORDS) {
        expect(s.toLowerCase()).not.toContain(word);
      }
    }
  });
});

describe("guidanceCopy", () => {
  it("maps each gating/validation code to distinct copy", () => {
    expect(guidanceCopy("closeNoFirst")).toBe(CLOSE_NO_FIRST);
    expect(guidanceCopy("closeYesFirst")).toBe(CLOSE_YES_FIRST);
    expect(guidanceCopy("noLiquidity")).toBe(NO_LIQUIDITY);
    expect(guidanceCopy("invalid")).toBe(INVALID_INPUT);
  });
});

describe("programErrorCopy", () => {
  it("maps known program errors to specific copy", () => {
    expect(programErrorCopy("Paused")).toBe(TRADING_PAUSED);
    expect(programErrorCopy("BookFull")).toBe(BOOK_FULL);
    expect(programErrorCopy("InsufficientFill")).toBe(NO_LIQUIDITY);
    expect(programErrorCopy("MarketSettled")).toBe(MARKET_SETTLED);
    expect(programErrorCopy("MarketClosed")).toBe(MARKET_CLOSED);
  });

  it("falls back to a generic message for WrongSide and unknown errors", () => {
    expect(programErrorCopy("WrongSide")).toBe(ORDER_COULD_NOT_BE_PLACED);
    expect(programErrorCopy("SomethingElse")).toBe(ORDER_COULD_NOT_BE_PLACED);
    expect(programErrorCopy(undefined)).toBe(ORDER_COULD_NOT_BE_PLACED);
  });
});

describe("estimateLabel", () => {
  it("shows 'You pay' for a positive cost", () => {
    expect(estimateLabel(1_000_000n)).toBe("You pay $1.00");
  });

  it("shows 'You receive' for a negative cost", () => {
    expect(estimateLabel(-1_000_000n)).toBe("You receive $1.00");
  });

  it("never mentions fill counts (copy audit)", () => {
    expect(estimateLabel(650_000n)).toBe("You pay $0.65");
  });
});

describe("winIfRightLabel", () => {
  it("is qty times $1.00", () => {
    expect(winIfRightLabel(3n)).toBe("You win $3.00 if right");
  });

  it("handles a single contract", () => {
    expect(winIfRightLabel(1n)).toBe("You win $1.00 if right");
  });

  it("notes the matched amount in plain words when less than what was requested", () => {
    expect(winIfRightLabel(2n, 5n)).toBe("You win $2.00 if right (for the 2 that can trade now)");
  });

  it("omits the note when the matched amount equals the requested amount", () => {
    expect(winIfRightLabel(5n, 5n)).toBe("You win $5.00 if right");
  });
});

describe("lockedUntilFilledLabel", () => {
  it("reports the reserved amount for a No-side market estimate", () => {
    expect(lockedUntilFilledLabel(1_000_000n)).toBe("Reserves $1.00 until it trades");
  });

  it("also reports the per-contract return for a No-limit order", () => {
    expect(lockedUntilFilledLabel(1_000_000n, 400_000n)).toBe(
      "Returns $0.40 per contract when it trades. Reserves $1.00 until it trades",
    );
  });
});

describe("closeButtonLabel", () => {
  it("offers Sell No when Buy Yes is gated, and Sell Yes when Buy No is gated", () => {
    expect(closeButtonLabel("closeNoFirst")).toBe(ACTION_LABEL.sellNo);
    expect(closeButtonLabel("closeYesFirst")).toBe(ACTION_LABEL.sellYes);
  });
});

describe("marketOrderToastTitle", () => {
  it("reports a buy as 'Bought N Yes/No on TICKER $strike for $amount'", () => {
    expect(marketOrderToastTitle("buyYes", "AAPL", 345_000_000n, 2n, 1_100_000n)).toBe("Bought 2 Yes on AAPL $345 for $1.10");
  });

  it("reports a sell as 'Sold N Yes/No on TICKER $strike for $amount'", () => {
    expect(marketOrderToastTitle("sellNo", "AAPL", 345_000_000n, 2n, 900_000n)).toBe("Sold 2 No on AAPL $345 for $0.90");
  });

  it("uses the matched quantity given, not any other figure, and never signs the amount", () => {
    expect(marketOrderToastTitle("sellYes", "AAPL", 345_000_000n, 2n, -900_000n)).toBe("Sold 2 Yes on AAPL $345 for $0.90");
  });
});

describe("limitOrderToastTitle / limitOrderToastDetail", () => {
  it("reports a resting limit order as 'Order open: buy/sell N Yes/No at $price on TICKER $strike'", () => {
    expect(limitOrderToastTitle("buyYes", "AAPL", 345_000_000n, 2n, 550_000n)).toBe("Order open: buy 2 Yes at $0.55 on AAPL $345");
    expect(limitOrderToastTitle("sellNo", "AAPL", 345_000_000n, 1n, 450_000n)).toBe("Order open: sell 1 No at $0.45 on AAPL $345");
  });

  it("reports the reserved USDC amount as 'Reserved $amount until it trades' for a buy/sell-No limit order", () => {
    expect(limitOrderToastDetail("buyYes", 1_100_000n, 2n)).toBe("Reserved $1.10 until it trades");
    expect(limitOrderToastDetail("buyNo", 2_000_000n, 2n)).toBe("Reserved $2.00 until it trades");
    expect(limitOrderToastDetail("sellNo", 900_000n, 1n)).toBe("Reserved $0.90 until it trades");
  });

  it("reports the reserved Yes quantity for a Sell Yes limit order, never a dollar figure", () => {
    expect(limitOrderToastDetail("sellYes", 0n, 2n)).toBe("Reserved 2 Yes until it trades");
  });
});

describe("quotesPlacedToastTitle", () => {
  it("lists every quote placed on one market in order, bid as 'buy' and ask as 'sell'", () => {
    expect(
      quotesPlacedToastTitle("AAPL", 345_000_000n, [
        { side: "ask", priceMicro: 550_000n, qty: 2n },
        { side: "bid", priceMicro: 450_000n, qty: 2n },
      ]),
    ).toBe("Quotes placed on AAPL $345: sell 2 at $0.55, buy 2 at $0.45");
  });
});

describe("quotesCancelledToastTitle", () => {
  it("pluralizes 'quote' except for exactly one", () => {
    expect(quotesCancelledToastTitle(1)).toBe("Cancelled 1 quote");
    expect(quotesCancelledToastTitle(3)).toBe("Cancelled 3 quotes");
  });
});

describe("redeemCollectedToastTitle / redeemAllCollectedToastTitle", () => {
  it("reports a single redeem as 'Collected $amount from TICKER $strike'", () => {
    expect(redeemCollectedToastTitle(2_000_000n, "AAPL", 345_000_000n)).toBe("Collected $2.00 from AAPL $345");
  });

  it("reports Redeem all as 'Collected $amount across N markets', singular for exactly one", () => {
    expect(redeemAllCollectedToastTitle(5_000_000n, 3)).toBe("Collected $5.00 across 3 markets");
    expect(redeemAllCollectedToastTitle(1_000_000n, 1)).toBe("Collected $1.00 across 1 market");
  });
});

describe("stillOpenFragment", () => {
  it("reports the unmatched remainder of a limit order that also traded: 'N Yes/No still open at $price'", () => {
    expect(stillOpenFragment("buyYes", 1n, 550_000n)).toBe("1 Yes still open at $0.55");
    expect(stillOpenFragment("sellNo", 3n, 450_000n)).toBe("3 No still open at $0.45");
  });
});
