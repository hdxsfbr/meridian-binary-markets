"use client";

/**
 * Mounts exactly one `Config` poller and one prices poller for the whole
 * app, and shares their snapshots through `AppDataContext`. `useConfig` and
 * `usePrices` read that shared snapshot when it's present (the normal case:
 * this provider wraps the app in `layout.tsx`, above `Nav` and every page),
 * so no matter how many components call those hooks, there is still only
 * one `Config` account read and one prices poll in flight at a time.
 *
 * Without this provider, each caller of `useConfig`/`usePrices` would start
 * its own 15s poll (and, for `useConfig`, its own `onAccountChange`
 * subscription), multiplying RPC calls with every card that needs a price.
 */

import type { ReactNode } from "react";
import { useConfigPolling } from "./useConfig";
import { usePricesPolling } from "./usePrices";
import { AppDataContext, type AppData } from "./app-data-context";

export function AppDataProvider({ children }: { children: ReactNode }) {
  const config = useConfigPolling();
  const prices = usePricesPolling(config);

  const value: AppData = { config, prices };

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
