import { describe, expect, it } from "vitest";
import { diffPriceChars } from "./AnimatedPrice";

describe("diffPriceChars", () => {
  it("marks nothing changed when the strings are identical", () => {
    expect(diffPriceChars("$83000.92", "$83000.92")).toEqual(
      "$83000.92".split("").map((char) => ({ char, changed: false })),
    );
  });

  it("marks only the differing indices changed when lengths match", () => {
    const diff = diffPriceChars("$83000.92", "$83000.47");
    // "$83000." (indices 0-6) is shared; only the cents digits (7, 8) differ.
    expect(diff.slice(0, 7)).toEqual("$83000.".split("").map((char) => ({ char, changed: false })));
    expect(diff[7]).toEqual({ char: "4", changed: true, prevChar: "9" });
    expect(diff[8]).toEqual({ char: "7", changed: true, prevChar: "2" });
  });

  it("marks a single interior digit changed, leaving the rest static", () => {
    const diff = diffPriceChars("$0.65", "$0.75");
    expect(diff.map((d) => d.changed)).toEqual([false, false, false, true, false]);
    expect(diff[3]).toEqual({ char: "7", changed: true, prevChar: "6" });
  });

  it("treats every character as changed when the string grows a digit ($999.99 -> $1000.00)", () => {
    const prev = "$999.99";
    const next = "$1000.00";
    const diff = diffPriceChars(prev, next);
    expect(diff).toHaveLength(next.length);
    expect(diff.every((d) => d.changed)).toBe(true);
    // No stable index alignment exists once lengths differ, so no `prevChar` is reported.
    expect(diff.every((d) => d.prevChar === undefined)).toBe(true);
    expect(diff.map((d) => d.char).join("")).toBe(next);
  });

  it("treats every character as changed when the string shrinks a digit ($1000.00 -> $999.99)", () => {
    const diff = diffPriceChars("$1000.00", "$999.99");
    expect(diff).toHaveLength("$999.99".length);
    expect(diff.every((d) => d.changed)).toBe(true);
    expect(diff.map((d) => d.char).join("")).toBe("$999.99");
  });

  it("marks a sign change as a full-string change (differing length via the leading '-')", () => {
    const diff = diffPriceChars("$0.10", "-$0.10");
    expect(diff.every((d) => d.changed)).toBe(true);
    expect(diff.map((d) => d.char).join("")).toBe("-$0.10");
  });
});
