/**
 * `publisher` job (contracts/automation.md, tasks.md T046): mock-provider
 * only. During 09:25-16:10 ET on trading days, publishes a price for every
 * enabled ticker every 60 s; a single source failure skips that ticker
 * (logged) without blocking the others. Refuses outright to run against
 * the `pyth` provider (contracts/oracle-provider.md "Selection": the mock
 * provider is the only one this job ever drives).
 */

import { DateTime } from "luxon";
import type { Ticker } from "@meridian/sdk";
import { ET_ZONE, isTradingDay, staticHolidaysFor, tradingDayOf } from "../calendar.js";
import { log, logError } from "../log.js";
import type { PriceProvider } from "../providers/PriceProvider.js";

const TICK_INTERVAL_MS = 60_000;
const WINDOW_START = { hour: 9, minute: 25 };
const WINDOW_END = { hour: 16, minute: 10 };

export interface PublisherChain {
  fetchConfig(): Promise<{ tickers: Array<{ symbol: Ticker; enabled: boolean }> }>;
}

export interface PublisherJobDeps {
  chain: PublisherChain;
  provider: PriceProvider;
  /** `AppConfig.oracleProvider`; the job refuses to run unless this is `"mock"`. */
  oracleProvider: "mock" | "pyth";
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PublisherJobOptions {
  once?: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if `nowSeconds` falls within 09:25:00-16:10:00 ET on a trading day. */
export function isWithinPublishWindow(nowSeconds: number): boolean {
  const dt = DateTime.fromSeconds(nowSeconds, { zone: ET_ZONE });
  const day = tradingDayOf(nowSeconds);

  let holidays: Set<string>;
  try {
    holidays = staticHolidaysFor(dt.year);
  } catch {
    // Unsupported year in the static holiday table: fail closed (don't publish)
    // rather than risk treating a holiday as a trading day.
    return false;
  }

  if (!isTradingDay(day, holidays)) return false;

  const minutesOfDay = dt.hour * 60 + dt.minute;
  const startMinutes = WINDOW_START.hour * 60 + WINDOW_START.minute;
  const endMinutes = WINDOW_END.hour * 60 + WINDOW_END.minute;
  return minutesOfDay >= startMinutes && minutesOfDay <= endMinutes;
}

/** Publishes once for every enabled ticker; a per-ticker source failure is logged and skipped. */
export async function runPublisherTick(deps: PublisherJobDeps): Promise<void> {
  if (deps.oracleProvider !== "mock") {
    throw new Error(
      `publisher job refuses to run with ORACLE_PROVIDER="${deps.oracleProvider}"; mock provider only`,
    );
  }

  const config = await deps.chain.fetchConfig();
  const enabledTickers = config.tickers.filter((t) => t.enabled).map((t) => t.symbol);

  await Promise.all(
    enabledTickers.map(async (ticker) => {
      try {
        await deps.provider.publish(ticker);
        log({ job: "publisher", ticker, step: "publish", ok: true });
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        logError({ job: "publisher", ticker, step: "publish", ok: false, error: message });
      }
    }),
  );
}

/**
 * Runs the publisher: with `--once`, a single tick regardless of the
 * window; otherwise loops every 60 s, ticking only while
 * `isWithinPublishWindow` is true, until the window closes for the day.
 */
export async function runPublisherJob(deps: PublisherJobDeps, opts: PublisherJobOptions = {}): Promise<void> {
  if (deps.oracleProvider !== "mock") {
    throw new Error(
      `publisher job refuses to run with ORACLE_PROVIDER="${deps.oracleProvider}"; mock provider only`,
    );
  }

  if (opts.once) {
    await runPublisherTick(deps);
    return;
  }

  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;

  while (isWithinPublishWindow(Math.floor(now() / 1000))) {
    await runPublisherTick(deps);
    await sleep(TICK_INTERVAL_MS);
  }
}
