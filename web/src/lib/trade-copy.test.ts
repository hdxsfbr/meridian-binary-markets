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
  lockedUntilFilledLabel,
  programErrorCopy,
  settledOutcomeCopy,
  winIfRightLabel,
} from "./trade-copy";

const FORBIDDEN_WORDS = ["mock", "provider", "pyth", "simulated", "todo", "stub", "placeholder", "coming soon"];

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
