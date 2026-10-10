import { describe, expect, it } from "vitest";
import { buildTokenMetadataJson, deriveTickerFromMintName } from "./token-metadata";

describe("deriveTickerFromMintName", () => {
  it("recovers the ticker from the standard Unicode form", () => {
    expect(deriveTickerFromMintName("AAPL ≥ $337 Yes Oct 10")).toBe("AAPL");
  });

  it("recovers the ticker from the ASCII >= fallback form", () => {
    expect(deriveTickerFromMintName("AAPL >= $337 Yes Oct 10")).toBe("AAPL");
  });

  it("recovers the ticker from the Y/N short-side fallback form", () => {
    expect(deriveTickerFromMintName("AAPL >= $337 Y Oct 10")).toBe("AAPL");
  });

  it("returns null for the last-resort form that drops the ticker", () => {
    expect(deriveTickerFromMintName(">=$337 Y 2026-10-10")).toBeNull();
  });

  it("returns null for an empty or unrecognized name", () => {
    expect(deriveTickerFromMintName("")).toBeNull();
    expect(deriveTickerFromMintName("not a mint name")).toBeNull();
  });
});

describe("buildTokenMetadataJson", () => {
  it("builds the standard metadata JSON with a trade-page external_url when the ticker is recoverable", () => {
    const result = buildTokenMetadataJson({
      name: "AAPL ≥ $339 Yes Oct 10",
      symbol: "MERIDIAN",
      origin: "https://web-production-385a5.up.railway.app",
    });
    expect(result).toEqual({
      name: "AAPL ≥ $339 Yes Oct 10",
      symbol: "MERIDIAN",
      description: "Meridian binary market token: AAPL ≥ $339 Yes Oct 10. Pays $1.00 if the market settles on this side, otherwise $0.",
      image: "https://web-production-385a5.up.railway.app/brand/token-logo.png",
      external_url: "https://web-production-385a5.up.railway.app/trade/AAPL",
    });
  });

  it("falls back to the home page when the ticker cannot be recovered from name", () => {
    const result = buildTokenMetadataJson({
      name: ">=$337 Y 2026-10-10",
      symbol: "MERIDIAN",
      origin: "https://example.com",
    });
    expect(result.external_url).toBe("https://example.com/");
  });

  it("strips a trailing slash from origin before building absolute URLs", () => {
    const result = buildTokenMetadataJson({
      name: "AAPL ≥ $339 No Oct 10",
      symbol: "MERIDIAN",
      origin: "https://example.com/",
    });
    expect(result.image).toBe("https://example.com/brand/token-logo.png");
    expect(result.external_url).toBe("https://example.com/trade/AAPL");
  });
});
