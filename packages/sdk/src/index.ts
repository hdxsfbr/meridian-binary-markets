import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID_BASE58 } from "#program-id";

/**
 * The Meridian program id. Sourced from `./program-id.ts`, a file generated
 * by `scripts/anchor-build.sh` from the synced keypair/Anchor.toml/declare_id!
 * so it can never drift from the on-chain id.
 */
export const PROGRAM_ID = new PublicKey(PROGRAM_ID_BASE58);

// NOTE: this barrel must stay browser-safe (no `node:*` imports) so it can be
// pulled into the Next.js client bundle. `loadIdl` lives in `./node.ts`
// (`@meridian/sdk/node`) because it reads from the filesystem.

export * from "#types";
export * from "#pda";
export * from "#strikes";
export { IDL } from "#idl";
export * from "#book";
export {
  toInstructionPlan,
  describeTransientState,
  PlaceOrderSide,
  TimeInForce,
  type Action,
  type Kind,
  type Intent,
  type Position as IntentPosition,
  type GuidanceError,
  type GuidanceErrorCode,
  type Estimate,
  type InstructionPlan,
  type PlaceOrderPlan,
  type BuyNoMarketPlan,
  type BuyNoLimitPlan,
  type SellNoMarketPlan,
} from "#intent";
export * from "#events";
export * from "#events-json";
export * from "#pnl";
export * from "#token";
