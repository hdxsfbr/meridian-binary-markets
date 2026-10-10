/**
 * Token-2022 migration: shared SPL token program ids and the one helper
 * every off-chain caller needs to find out which program actually owns a
 * given market's Yes/No mint.
 *
 * A `Market`'s Yes/No mints are classic SPL Token (legacy, pre-migration
 * markets) or Token-2022 (every market `create_market`/`add_strike`
 * creates from the Token-2022 migration on) -- the `Market` account itself
 * does not store which, the same way the on-chain program doesn't: both
 * sides derive it from the mint account's own `owner` at call time
 * (mirrors `state::market::require_matching_token_program` in
 * `programs/meridian/src/state/market.rs`). USDC mints/vaults/escrows are
 * unaffected by this migration and are always classic SPL Token.
 *
 * These ids were previously defined only in `web/src/lib/ata.ts`; they now
 * live here so every package (web, scripts, services/automation) imports
 * the same constants instead of redefining the raw pubkey strings.
 */

import { PublicKey, type Connection } from "@solana/web3.js";

/** Classic SPL Token program id. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Token-2022 (`token-2022`) program id. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Associated Token Account program id (shared by both token programs: same ATA id, different seed component). */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/**
 * Associated token account address for `owner`/`mint`. The ATA program id
 * is the same regardless of which token program owns `mint`, but the PDA
 * seeds include the token program's own pubkey as one of the components,
 * so the derived address differs between a classic-Token and a
 * Token-2022 mint for the same owner -- `tokenProgram` must match whichever
 * program actually owns `mint` (see `tokenProgramForMint` above). Defaults
 * to classic SPL Token for callers that haven't been updated to pass it
 * explicitly yet.
 */
export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Fetches `mint`'s account and returns its owner -- either
 * `TOKEN_PROGRAM_ID` or `TOKEN_2022_PROGRAM_ID` -- which is how every
 * off-chain caller determines, per market, which token program a given
 * Yes/No mint actually uses. Throws if the mint account does not exist
 * (there is no sensible default to fall back to: a caller asking this
 * question about a mint that isn't there has a bug elsewhere).
 */
export async function tokenProgramForMint(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (info === null) {
    throw new Error(`tokenProgramForMint: mint account ${mint.toBase58()} does not exist`);
  }
  return info.owner;
}

/** On-mint `TokenMetadata` TLV extension fields this codebase cares about (name/symbol/uri). */
export type OnMintTokenMetadata = { name: string; symbol: string; uri: string };

/** Byte length of the base (no-extensions) Token-2022/classic `Mint` account layout. A
 *  mint account of exactly this length carries no extensions at all. */
const CLASSIC_MINT_LEN = 82;

/**
 * Byte offset of the one-byte `AccountType` discriminant that precedes the TLV
 * extension entries on an *extended* Token-2022 account -- confirmed directly against a
 * real devnet mint rather than assumed: this is `Account::LEN` (165), not `Mint::LEN`
 * (82), *even for a Mint account*. spl-token-2022 pads every extended account's data out
 * to this fixed offset before writing the discriminant/TLV region, for both `Mint` and
 * `Account`, so a reader doesn't need to already know which base type it's looking at to
 * find the extensions -- a Mint-with-extensions is not simply `Mint::LEN + 1 + TLV...`.
 */
const ACCOUNT_TYPE_OFFSET = 165;

/** `ExtensionType::TokenMetadata`'s discriminant in spl-token-2022's `extension` module. */
const TOKEN_METADATA_EXTENSION_TYPE = 19;

/** A `DataView` over `data`'s exact byte range, regardless of whether `data` is a `Buffer`
 *  (Node) or a plain `Uint8Array` (browser `fetch` response) -- both are `Uint8Array`s with
 *  a `byteOffset` into a possibly-larger backing `buffer`, so this must never assume
 *  `byteOffset === 0`. */
function dataViewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Parses the on-mint `TokenMetadata` TLV extension (name/symbol/uri) out of a raw
 * Token-2022 mint account's data, as written by `init_token_metadata` in
 * `programs/meridian/src/instructions/create_market.rs`. Returns `null` for a mint with
 * no extensions at all (exactly `CLASSIC_MINT_LEN` bytes -- includes every classic-Token
 * mint), a mint whose extensions don't include `TokenMetadata`, or any TLV entry that is
 * truncated/malformed -- there is no SDK equivalent of `@solana/spl-token`'s
 * `getTokenMetadata` in this dependency set (see `token.ts`'s module doc comment and
 * `web/src/app/api/token/[mint]/route.ts`, the only caller), so this is a hand-rolled,
 * minimal Borsh-shaped decoder: `TokenMetadata`'s wire format is
 * `update_authority: [u8; 32]`, `mint: [u8; 32]`, then three length-prefixed (`u32` LE)
 * UTF-8 strings (`name`, `symbol`, `uri`), then a length-prefixed `additional_metadata`
 * this function never reads.
 */
export function parseTokenMetadataExtension(data: Uint8Array): OnMintTokenMetadata | null {
  if (data.length <= CLASSIC_MINT_LEN || data.length <= ACCOUNT_TYPE_OFFSET) {
    return null;
  }

  try {
    const view = dataViewOf(data);
    let offset = ACCOUNT_TYPE_OFFSET + 1;
    while (offset + 4 <= data.length) {
      const extensionType = view.getUint16(offset, true);
      const extensionLength = view.getUint16(offset + 2, true);
      offset += 4;
      if (offset + extensionLength > data.length) {
        return null;
      }
      if (extensionType === TOKEN_METADATA_EXTENSION_TYPE) {
        return decodeTokenMetadataValue(data.subarray(offset, offset + extensionLength));
      }
      offset += extensionLength;
    }
    return null;
  } catch {
    return null;
  }
}

/** Decodes a `TokenMetadata` TLV value's bytes (see `parseTokenMetadataExtension`'s doc comment). */
function decodeTokenMetadataValue(value: Uint8Array): OnMintTokenMetadata | null {
  const view = dataViewOf(value);
  const decoder = new TextDecoder();
  let offset = 32 + 32; // update_authority, mint

  function readString(): string {
    const len = view.getUint32(offset, true);
    offset += 4;
    const bytes = value.subarray(offset, offset + len);
    offset += len;
    return decoder.decode(bytes);
  }

  if (offset + 4 > value.length) {
    return null;
  }
  const name = readString();
  const symbol = readString();
  const uri = readString();
  return { name, symbol, uri };
}
