import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@meridian/sdk";
import { assertGenesisHash, associatedTokenAddress, DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TOKEN_PROGRAM_ID } from "../lib/client.js";

function mockConnection(genesisHash: string): Connection {
  return { getGenesisHash: async () => genesisHash } as unknown as Connection;
}

describe("assertGenesisHash (fix #3)", () => {
  it("refuses mainnet-beta's genesis hash on devnet", async () => {
    await expect(assertGenesisHash(mockConnection(MAINNET_GENESIS_HASH), "devnet")).rejects.toThrow(/mainnet/i);
  });

  it("refuses mainnet-beta's genesis hash on localnet", async () => {
    await expect(assertGenesisHash(mockConnection(MAINNET_GENESIS_HASH), "localnet")).rejects.toThrow(/mainnet/i);
  });

  it("accepts devnet's genesis hash when CLUSTER=devnet", async () => {
    await expect(assertGenesisHash(mockConnection(DEVNET_GENESIS_HASH), "devnet")).resolves.toBeUndefined();
  });

  it("refuses a mismatched genesis hash when CLUSTER=devnet", async () => {
    await expect(assertGenesisHash(mockConnection("someOtherGenesisHash111111111111"), "devnet")).rejects.toThrow(
      /devnet/i,
    );
  });

  it("accepts any non-mainnet genesis hash on localnet", async () => {
    await expect(
      assertGenesisHash(mockConnection("freshLocalValidatorGenesisHash11"), "localnet"),
    ).resolves.toBeUndefined();
  });
});

describe("associatedTokenAddress (Token-2022 migration)", () => {
  it("defaults to classic SPL Token and differs from the Token-2022 derivation for the same owner/mint", () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const classic = associatedTokenAddress(owner, mint);
    const explicitClassic = associatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID);
    const token2022 = associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM_ID);
    expect(classic.equals(explicitClassic)).toBe(true);
    expect(classic.equals(token2022)).toBe(false);
  });
});
