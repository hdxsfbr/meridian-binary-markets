import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { associatedTokenAddress, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./ata";
import { fetchConfirmedTransaction, fetchYesNoTokenProgram, makerAccountsFor } from "./tx";

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

  it("derives the Yes leg under Token-2022 when tokenPrograms.yes is passed (ask taker / buyNoMarket)", () => {
    const owners = makers(2);
    const result = makerAccountsFor(owners, "askTaker", mints, { usdc: TOKEN_PROGRAM_ID, yes: TOKEN_2022_PROGRAM_ID });
    expect(result).toEqual(owners.map((o) => associatedTokenAddress(o, yesMint, TOKEN_2022_PROGRAM_ID)));
    // Sanity: the Token-2022 derivation differs from the classic default.
    expect(result).not.toEqual(owners.map((o) => associatedTokenAddress(o, yesMint)));
  });

  it("keeps the USDC leg classic even when tokenPrograms.yes is Token-2022 (bid taker / sellNoMarket)", () => {
    const owners = makers(2);
    const result = makerAccountsFor(owners, "sellNoMarket", mints, { usdc: TOKEN_PROGRAM_ID, yes: TOKEN_2022_PROGRAM_ID });
    expect(result).toEqual(owners.map((o) => associatedTokenAddress(o, usdcMint, TOKEN_PROGRAM_ID)));
  });
});

describe("fetchYesNoTokenProgram", () => {
  it("resolves the Yes mint's owner via the program's connection", async () => {
    const owner = TOKEN_2022_PROGRAM_ID;
    const getAccountInfo = vi.fn().mockResolvedValue({ owner });
    const program = {
      provider: { connection: { getAccountInfo } as unknown as Connection },
    } as unknown as import("@anchor-lang/core").Program;
    const market = Keypair.generate().publicKey;

    const result = await fetchYesNoTokenProgram(program, market);
    expect(result.equals(owner)).toBe(true);
    expect(getAccountInfo).toHaveBeenCalledTimes(1);
  });
});

describe("fetchConfirmedTransaction", () => {
  function fakeTx(): { fake: true } {
    return { fake: true };
  }

  it("returns the transaction immediately once getTransaction finds it", async () => {
    const getTransaction = vi.fn().mockResolvedValue(fakeTx());
    const connection = { getTransaction } as unknown as Connection;
    const result = await fetchConfirmedTransaction(connection, "sig", 5, 0);
    expect(result).toEqual(fakeTx());
    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(getTransaction).toHaveBeenCalledWith("sig", { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  });

  it("retries on null up to maxRetries, then returns the transaction if a later attempt finds it", async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fakeTx());
    const connection = { getTransaction } as unknown as Connection;
    const result = await fetchConfirmedTransaction(connection, "sig", 5, 0);
    expect(result).toEqual(fakeTx());
    expect(getTransaction).toHaveBeenCalledTimes(3);
  });

  it("gives up and returns null after exhausting maxRetries, never calling getTransaction more than maxRetries + 1 times", async () => {
    const getTransaction = vi.fn().mockResolvedValue(null);
    const connection = { getTransaction } as unknown as Connection;
    const result = await fetchConfirmedTransaction(connection, "sig", 2, 0);
    expect(result).toBeNull();
    expect(getTransaction).toHaveBeenCalledTimes(3); // the initial attempt + 2 retries
  });

  it("spaces retries by the given delay rather than retrying immediately", async () => {
    vi.useFakeTimers();
    try {
      const getTransaction = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(fakeTx());
      const connection = { getTransaction } as unknown as Connection;
      const promise = fetchConfirmedTransaction(connection, "sig", 5, 1_000);

      await vi.advanceTimersByTimeAsync(0);
      expect(getTransaction).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(getTransaction).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(getTransaction).toHaveBeenCalledTimes(2);

      expect(await promise).toEqual(fakeTx());
    } finally {
      vi.useRealTimers();
    }
  });
});
