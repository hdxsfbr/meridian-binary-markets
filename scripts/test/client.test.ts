import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { assertGenesisHash, DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from "../lib/client.js";

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
