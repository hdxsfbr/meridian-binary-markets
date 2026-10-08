import { describe, expect, it } from "vitest";
import {
  countdownLabel,
  formatCountdown,
  formatPrice,
  formatSignedUsd,
  formatStrike,
  formatUsd,
  impliedProbability,
  oppositePrice,
  payoutMultiple,
} from "./format";

describe("formatUsd", () => {
  it("formats whole dollars", () => {
    expect(formatUsd(1_000_000n)).toBe("$1.00");
  });

  it("formats cents", () => {
    expect(formatUsd(650_000n)).toBe("$0.65");
  });

  it("formats large values with cents", () => {
    expect(formatUsd(333_410_000n)).toBe("$333.41");
  });

  it("formats zero", () => {
    expect(formatUsd(0n)).toBe("$0.00");
  });

  it("formats negative values", () => {
    expect(formatUsd(-650_000n)).toBe("-$0.65");
  });

  it("pads single-digit cents", () => {
    expect(formatUsd(1_050_000n)).toBe("$1.05");
  });
});

describe("formatSignedUsd", () => {
  it("prepends a plus sign on a positive amount", () => {
    expect(formatSignedUsd(1_000_000n)).toBe("+$1.00");
  });

  it("keeps the minus sign on a negative amount", () => {
    expect(formatSignedUsd(-650_000n)).toBe("-$0.65");
  });

  it("has no sign at zero", () => {
    expect(formatSignedUsd(0n)).toBe("$0.00");
  });
});

describe("formatPrice", () => {
  it("matches formatUsd", () => {
    expect(formatPrice(650_000n)).toBe("$0.65");
  });
});

describe("impliedProbability", () => {
  it("converts a yes price to a percentage", () => {
    expect(impliedProbability(650_000n)).toBe("65%");
  });

  it("handles 0", () => {
    expect(impliedProbability(0n)).toBe("0%");
  });

  it("handles 100%", () => {
    expect(impliedProbability(1_000_000n)).toBe("100%");
  });
});

describe("payoutMultiple", () => {
  it("is $1.00 divided by the price", () => {
    expect(payoutMultiple(500_000n)).toBe("2.00x");
  });

  it("truncates to two decimal places", () => {
    expect(payoutMultiple(600_000n)).toBe("1.66x");
  });

  it("is 1.00x at a $1.00 price", () => {
    expect(payoutMultiple(1_000_000n)).toBe("1.00x");
  });

  it("is blank for undefined (no price to quote against)", () => {
    expect(payoutMultiple(undefined)).toBe("");
  });

  it("is blank for zero or negative", () => {
    expect(payoutMultiple(0n)).toBe("");
    expect(payoutMultiple(-100n)).toBe("");
  });
});

describe("oppositePrice", () => {
  it("is 1.00 minus the price", () => {
    expect(oppositePrice(650_000n)).toBe(350_000n);
  });

  it("round-trips to the original price", () => {
    expect(oppositePrice(oppositePrice(650_000n))).toBe(650_000n);
  });

  it("handles the boundary at 1", () => {
    expect(oppositePrice(1n)).toBe(999_999n);
  });

  it("handles the boundary at 999_999", () => {
    expect(oppositePrice(999_999n)).toBe(1n);
  });
});

describe("formatStrike", () => {
  it("formats a whole-dollar strike", () => {
    expect(formatStrike(680_000_000n)).toBe("$680");
  });

  it("formats zero", () => {
    expect(formatStrike(0n)).toBe("$0");
  });

  it("formats a fractional strike with two decimals", () => {
    expect(formatStrike(680_500_000n)).toBe("$680.50");
  });

  it("formats a negative fractional strike", () => {
    expect(formatStrike(-680_500_000n)).toBe("-$680.50");
  });

  it("pads single-digit cents", () => {
    expect(formatStrike(680_050_000n)).toBe("$680.05");
  });
});

describe("formatCountdown", () => {
  it("formats hours and minutes", () => {
    expect(formatCountdown(3 * 3600 + 12 * 60)).toBe("3h 12m");
  });

  it("formats minutes and seconds under an hour", () => {
    expect(formatCountdown(45)).toBe("0m 45s");
  });

  it("formats minutes with seconds", () => {
    expect(formatCountdown(125)).toBe("2m 5s");
  });

  it("clamps negative values to zero", () => {
    expect(formatCountdown(-10)).toBe("0m 0s");
  });

  it("formats exactly zero", () => {
    expect(formatCountdown(0)).toBe("0m 0s");
  });

  it("formats exactly one hour", () => {
    expect(formatCountdown(3600)).toBe("1h 0m");
  });
});

describe("countdownLabel", () => {
  it("shows the remaining time before close", () => {
    expect(countdownLabel(1000, 1000 + 3 * 3600 + 12 * 60)).toBe("3h 12m");
  });

  it("shows 'Settlement pending' after close, before an outcome", () => {
    expect(countdownLabel(2000, 1000)).toBe("Settlement pending");
  });

  it("shows 'Settlement pending' exactly at close", () => {
    expect(countdownLabel(1000, 1000)).toBe("Settlement pending");
  });

  it("shows nothing once settled, even after close", () => {
    expect(countdownLabel(2000, 1000, true)).toBeNull();
  });

  it("shows nothing once settled, even before close", () => {
    expect(countdownLabel(500, 1000, true)).toBeNull();
  });
});
