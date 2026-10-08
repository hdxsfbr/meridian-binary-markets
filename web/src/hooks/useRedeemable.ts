"use client";

/**
 * The connected wallet's total redeemable value right now -- every settled
 * winning payout plus `$1` per held pair, across every market -- for the
 * nav's "redeem all" pill (REVAMP_PLAN Wave R4) and the Portfolio banner.
 * Reuses `usePositions` (which itself reads the shared snapshot from
 * `AppDataProvider` when mounted, so this adds no extra polling) and the
 * pure `redeemableMicro` from `redeem-all.ts`.
 */

import { useWallet } from "@solana/wallet-adapter-react";
import { redeemableMicro } from "@/lib/redeem-all";
import { usePositions } from "./usePositions";

export type UseRedeemableResult = {
  /** Total redeemable micro-USDC across every market; 0n while disconnected or nothing to collect. */
  redeemableMicro: bigint;
  /** True once positions have loaded at least once for the connected wallet. */
  loading: boolean;
};

export function useRedeemable(): UseRedeemableResult {
  const { publicKey } = useWallet();
  const { rows, loading } = usePositions(publicKey ?? null);
  return {
    redeemableMicro: publicKey === null ? 0n : redeemableMicro(rows),
    loading,
  };
}
