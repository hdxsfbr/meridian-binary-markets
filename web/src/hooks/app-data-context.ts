"use client";

/**
 * The context `useConfig`/`usePrices` read from when `AppDataProvider` is
 * mounted above them, so the whole app shares one `Config` poller and one
 * prices poller rather than each caller starting its own. A separate module
 * from `useConfig.ts`/`usePrices.ts` so `AppDataProvider.tsx` (which needs
 * the polling implementations) and those hook files (which need this
 * context) don't import each other in a cycle.
 */

import { createContext } from "react";
import type { Ticker } from "@meridian/sdk";
import type { ConfigSnapshot } from "./useConfig";
import type { TickerPrice } from "./usePrices";

export type AppData = {
  config: ConfigSnapshot | null;
  prices: Partial<Record<Ticker, TickerPrice>>;
};

export const AppDataContext = createContext<AppData | undefined>(undefined);
