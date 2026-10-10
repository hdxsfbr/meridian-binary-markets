/**
 * Re-exports the shared token-program constants and ATA derivation from
 * `@meridian/sdk` (`packages/sdk/src/token.ts`), which is now the single
 * source of truth -- this file previously defined its own copies of
 * `TOKEN_PROGRAM_ID`/`ASSOCIATED_TOKEN_PROGRAM_ID` and a classic-only
 * `associatedTokenAddress`, duplicated across `web`, `scripts`, and
 * `services/automation`. Token-2022 migration: every consumer in this app
 * now passes the market-specific token program explicitly (see
 * `tx.ts`'s `BuildCtx.yesNoTokenProgram`) rather than relying on a
 * hardcoded classic default.
 */
export {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  tokenProgramForMint,
} from "@meridian/sdk";
