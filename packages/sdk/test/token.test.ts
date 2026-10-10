import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  parseTokenMetadataExtension,
  tokenProgramForMint,
} from "../src/token";

/** Builds a synthetic Token-2022 mint account's raw `data` with a `TokenMetadata`
 *  extension holding `name`/`symbol`/`uri`, matching the real on-chain layout confirmed
 *  against a devnet mint (`web/src/app/api/token/[mint]/route.ts`'s verification curl):
 *  zero-padded base `Mint` region up through `ACCOUNT_TYPE_OFFSET` (165) -- *not* 82,
 *  even though `Mint::LEN` is 82 -- then a one-byte `AccountType::Mint` (1) at offset
 *  165, then one TLV entry at offset 166 (`type=19`, `length`, then
 *  `update_authority`[32] + `mint`[32] + three length-prefixed UTF-8 strings). */
function buildMintMetadataAccountData(fields: { name: string; symbol: string; uri: string }): Buffer {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(fields.name);
  const symbolBytes = encoder.encode(fields.symbol);
  const uriBytes = encoder.encode(fields.uri);

  const value = Buffer.alloc(32 + 32 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 4);
  let o = 64; // update_authority(32) + mint(32), left zeroed
  value.writeUInt32LE(nameBytes.length, o);
  o += 4;
  value.set(nameBytes, o);
  o += nameBytes.length;
  value.writeUInt32LE(symbolBytes.length, o);
  o += 4;
  value.set(symbolBytes, o);
  o += symbolBytes.length;
  value.writeUInt32LE(uriBytes.length, o);
  o += 4;
  value.set(uriBytes, o);
  o += uriBytes.length;
  // trailing additional_metadata count (0), already zeroed by Buffer.alloc's extra slot

  const header = Buffer.alloc(165 + 1 + 4);
  header[165] = 1; // AccountType::Mint
  header.writeUInt16LE(19, 166); // TokenMetadata extension type
  header.writeUInt16LE(value.length, 168);

  return Buffer.concat([header, value]);
}

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

describe("parseTokenMetadataExtension", () => {
  it("decodes name/symbol/uri from a mint account's TokenMetadata TLV extension", () => {
    const data = buildMintMetadataAccountData({
      name: "AAPL ≥ $337 Yes Oct 10",
      symbol: "MERIDIAN",
      uri: "https://web-production-385a5.up.railway.app/api/token/Fg6PaF.json",
    });
    const result = parseTokenMetadataExtension(data);
    expect(result).toEqual({
      name: "AAPL ≥ $337 Yes Oct 10",
      symbol: "MERIDIAN",
      uri: "https://web-production-385a5.up.railway.app/api/token/Fg6PaF.json",
    });
  });

  it("decodes correctly when the account data starts at a non-zero byteOffset (a Buffer subarray)", () => {
    const data = buildMintMetadataAccountData({ name: "N", symbol: "S", uri: "U" });
    const padded = Buffer.concat([Buffer.alloc(16), data]);
    const sliced = padded.subarray(16);
    expect(parseTokenMetadataExtension(sliced)).toEqual({ name: "N", symbol: "S", uri: "U" });
  });

  it("returns null for a classic (no-extensions) mint, exactly CLASSIC_MINT_LEN (82) bytes", () => {
    expect(parseTokenMetadataExtension(Buffer.alloc(82))).toBeNull();
  });

  it("returns null for a Token-2022 mint with extensions but no TokenMetadata (e.g. just MintCloseAuthority)", () => {
    // AccountType::Mint at the fixed offset 165, then one TLV entry of some other
    // extension type (3 = MintCloseAuthority), 32-byte value.
    const header = Buffer.alloc(165 + 1 + 4);
    header[165] = 1;
    header.writeUInt16LE(3, 166);
    header.writeUInt16LE(32, 168);
    const data = Buffer.concat([header, Buffer.alloc(32)]);
    expect(parseTokenMetadataExtension(data)).toBeNull();
  });

  it("returns null for a truncated/malformed TLV entry rather than throwing", () => {
    const data = buildMintMetadataAccountData({ name: "N", symbol: "S", uri: "U" });
    expect(parseTokenMetadataExtension(data.subarray(0, data.length - 10))).toBeNull();
  });
});
