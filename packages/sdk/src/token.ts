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
