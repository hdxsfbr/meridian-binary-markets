import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  tokenProgramForMint,
} from "../src/token";

describe("associatedTokenAddress", () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;

  it("defaults to classic SPL Token when tokenProgram is omitted", () => {
    const result = associatedTokenAddress(owner, mint);
    const expected = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];
    expect(result.equals(expected)).toBe(true);
  });

  it("derives a different address for the same owner/mint under Token-2022", () => {
    const classic = associatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID);
    const token2022 = associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM_ID);
    expect(classic.equals(token2022)).toBe(false);
  });

  it("is deterministic for a given owner/mint/tokenProgram", () => {
    const a = associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM_ID);
    const b = associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM_ID);
    expect(a.equals(b)).toBe(true);
  });
});

describe("tokenProgramForMint", () => {
  function mockConnection(owner: PublicKey | null) {
    return {
      getAccountInfo: async () => (owner === null ? null : { owner }),
    } as unknown as import("@solana/web3.js").Connection;
  }

  it("returns the mint account's owner", async () => {
    const result = await tokenProgramForMint(mockConnection(TOKEN_2022_PROGRAM_ID), Keypair.generate().publicKey);
    expect(result.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("returns the classic program id for a classic mint", async () => {
    const result = await tokenProgramForMint(mockConnection(TOKEN_PROGRAM_ID), Keypair.generate().publicKey);
    expect(result.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("throws if the mint account does not exist", async () => {
    await expect(tokenProgramForMint(mockConnection(null), Keypair.generate().publicKey)).rejects.toThrow(/does not exist/);
  });
});
