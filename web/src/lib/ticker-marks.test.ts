import { describe, expect, it } from "vitest";
import { TICKERS, type Ticker } from "@meridian/sdk";
import { TICKER_COLORS, TICKER_MARKS } from "./ticker-marks";

/** Listed tickers without a drawn mark; the component falls back to text initials for these. */
const NO_MARK: readonly Ticker[] = [];

describe("TICKER_MARKS", () => {
  for (const ticker of TICKERS) {
    if (NO_MARK.includes(ticker)) continue;
    it(`has a mark for ${ticker}`, () => {
      const svg = TICKER_MARKS[ticker];
      expect(svg).toBeDefined();
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
    });
  }

  it("draws AMZN from the public-domain Amazon icon with the smile kept orange", () => {
    const svg = TICKER_MARKS.AMZN ?? "";
    expect(svg).toContain('fill="#f90"');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain('fill="#000"');
  });

  it("falls back for an unlisted ticker, e.g. an ETF added only via admin config", () => {
    expect(TICKER_MARKS.QQQ).toBeUndefined();
    expect(TICKER_MARKS.VOO).toBeUndefined();
    expect(TICKER_MARKS.SPY).toBeUndefined();
  });

  it("draws MSFT as four colored squares rather than importing a Simple Icons mark", () => {
    const svg = TICKER_MARKS.MSFT ?? "";
    const rectCount = (svg.match(/<rect/g) ?? []).length;
    expect(rectCount).toBe(4);
    expect(svg).toContain("#F25022");
    expect(svg).toContain("#7FBA00");
    expect(svg).toContain("#00A4EF");
    expect(svg).toContain("#FFB900");
  });

  it("strips the Simple Icons <title> element so no tooltip duplicates the ticker label", () => {
    for (const ticker of TICKERS) {
      const svg = TICKER_MARKS[ticker];
      if (svg === undefined) continue;
      expect(svg).not.toContain("<title>");
    }
  });

  it("keeps TSLA's mark even though BTC replaced it in the default TICKERS set (DECISIONS.md §30)", () => {
    const svg = TICKER_MARKS.TSLA ?? "";
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("<title>");
  });

  it("has a Simple Icons mark for BTC with no <title> element", () => {
    const svg = TICKER_MARKS.BTC ?? "";
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).not.toContain("<title>");
  });
});

describe("TICKER_COLORS", () => {
  it("gives AMZN the text colour so the letter follows the theme while the smile stays orange", () => {
    expect(TICKER_COLORS.AMZN).toBe("var(--color-text)");
  });

  it("leaves MSFT uncolored since its mark carries its own four fills", () => {
    expect(TICKER_COLORS.MSFT).toBeUndefined();
  });

  it("gives BTC its brand orange", () => {
    expect(TICKER_COLORS.BTC).toBe("#F7931A");
  });
});
