import { describe, expect, it } from "vitest";
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
  programErrorCopy,
  settledOutcomeCopy,
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
    estimateLabel(1_000_000n, 0),
    estimateLabel(-1_000_000n, 3),
    estimateLabel(650_000n, 1),
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
  });

  it("falls back to a generic message for WrongSide and unknown errors", () => {
    expect(programErrorCopy("WrongSide")).toBe(ORDER_COULD_NOT_BE_PLACED);
    expect(programErrorCopy("SomethingElse")).toBe(ORDER_COULD_NOT_BE_PLACED);
    expect(programErrorCopy(undefined)).toBe(ORDER_COULD_NOT_BE_PLACED);
  });
});

describe("estimateLabel", () => {
  it("shows 'You pay' for a positive cost with no fill count when zero", () => {
    expect(estimateLabel(1_000_000n, 0)).toBe("You pay $1.00");
  });

  it("shows 'You receive' for a negative cost, with fill count pluralized", () => {
    expect(estimateLabel(-1_000_000n, 3)).toBe("You receive $1.00 (3 fills)");
  });

  it("singularizes a single fill", () => {
    expect(estimateLabel(650_000n, 1)).toBe("You pay $0.65 (1 fill)");
  });
});

describe("closeButtonLabel", () => {
  it("offers Sell No when Buy Yes is gated, and Sell Yes when Buy No is gated", () => {
    expect(closeButtonLabel("closeNoFirst")).toBe(ACTION_LABEL.sellNo);
    expect(closeButtonLabel("closeYesFirst")).toBe(ACTION_LABEL.sellYes);
  });
});
