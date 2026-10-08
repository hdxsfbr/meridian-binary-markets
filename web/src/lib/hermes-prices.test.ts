import { describe, expect, it } from "vitest";
import { hermesToDisplayPrices, scaleToMicroUsd } from "./hermes-prices";

describe("hermesToDisplayPrices", () => {
  it("scales Hermes price/expo to micro-USD and keys by lowercase feed id", () => {
    const body = {
      parsed: [
        { id: "16DAD506", price: { price: "37186950", expo: -5, publish_time: 1791475415, conf: "3550" } },
        { id: "0xabcd", price: { price: "75245801", expo: -5, publish_time: 1791475443, conf: "1" } },
      ],
    };
    const out = hermesToDisplayPrices(body);
    expect(out["16dad506"]).toEqual({ priceMicro: "371869500", publishTime: 1791475415 });
    expect(out["abcd"].priceMicro).toBe("752458010");
  });

  it("returns an empty map for a malformed body", () => {
    expect(hermesToDisplayPrices(null)).toEqual({});
    expect(hermesToDisplayPrices({ parsed: "nope" })).toEqual({});
  });

  it("scales positive and negative exponents", () => {
    expect(scaleToMicroUsd(5n, 0)).toBe(5_000_000n);
    expect(scaleToMicroUsd(8107499292843n, -8)).toBe(81_074_992_928n);
  });
});
