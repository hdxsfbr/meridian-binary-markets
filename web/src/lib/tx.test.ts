import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { associatedTokenAddress } from "./ata";
import { makerAccountsFor } from "./tx";

const usdcMint = Keypair.generate().publicKey;
const yesMint = Keypair.generate().publicKey;
const mints = { usdc: usdcMint, yes: yesMint };

function makers(n: number): PublicKey[] {
  return Array.from({ length: n }, () => Keypair.generate().publicKey);
}

describe("makerAccountsFor", () => {
  it("uses the USDC mint for a bid taker (buy Yes: makers are ask owners, paid in USDC)", () => {
    const owners = makers(3);
    const result = makerAccountsFor(owners, "bidTaker", mints);
    expect(result).toEqual(owners.map((o) => associatedTokenAddress(o, usdcMint)));
  });

  it("uses the Yes mint for an ask taker (sell Yes: makers are bid owners, paid in Yes)", () => {
    const owners = makers(3);
    const result = makerAccountsFor(owners, "askTaker", mints);
    expect(result).toEqual(owners.map((o) => associatedTokenAddress(o, yesMint)));
  });

  it("uses the Yes mint for buy_no_market (internally sells Yes IOC into bids)", () => {
    const owners = makers(2);
    const result = makerAccountsFor(owners, "buyNoMarket", mints);
    expect(result).toEqual(owners.map((o) => associatedTokenAddress(o, yesMint)));
  });

  it("uses the USDC mint for sell_no_market (internally buys Yes IOC from asks)", () => {
    const owners = makers(2);
    const result = makerAccountsFor(owners, "sellNoMarket", mints);
    expect(result).toEqual(owners.map((o) => associatedTokenAddress(o, usdcMint)));
  });

  it("derives a distinct ATA per maker, not the same address repeated", () => {
    const owners = makers(4);
    const result = makerAccountsFor(owners, "bidTaker", mints);
    const unique = new Set(result.map((pk) => pk.toBase58()));
    expect(unique.size).toBe(4);
  });

  it("caps the result at the program's MAX_FILLS (8) even if given more makers", () => {
    const owners = makers(12);
    const result = makerAccountsFor(owners, "bidTaker", mints);
    expect(result).toHaveLength(8);
    expect(result).toEqual(owners.slice(0, 8).map((o) => associatedTokenAddress(o, usdcMint)));
  });

  it("returns an empty list for zero makers", () => {
    expect(makerAccountsFor([], "bidTaker", mints)).toEqual([]);
  });
});
