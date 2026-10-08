"use client";

/**
 * Mounts exactly one `Config` poller, one prices poller, and one positions
 * poller for the whole app, and shares their snapshots through
 * `AppDataContext`. `useConfig`, `usePrices`, and `usePositions` read that
 * shared snapshot when it's present (the normal case: this provider wraps
 * the app in `layout.tsx`, above `Nav` and every page), so no matter how
 * many components call those hooks, there is still only one `Config`
 * account read, one prices poll, and one positions poll in flight at a time.
 *
 * Without this provider, each caller of `useConfig`/`usePrices`/`usePositions`
 * would start its own poll (and, for `useConfig`, its own `onAccountChange`
 * subscription), multiplying RPC calls with every card that needs a price,
 * or every page/pill that needs to know what's redeemable.
 */

import type { ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConfigPolling } from "./useConfig";
import { usePricesPolling } from "./usePrices";
import { usePositionsPolling } from "./usePositions";
import { AppDataContext, type AppData } from "./app-data-context";

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { publicKey } = useWallet();
  const config = useConfigPolling();
  const prices = usePricesPolling(config);
  const positions = usePositionsPolling(publicKey ?? null);

  const value: AppData = { config, prices, positions };

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
