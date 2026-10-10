/**
 * Pure helpers for the Markets/Landing pages: grouping decoded `Market`
 * accounts by ticker, counting today's open contracts, and computing the
 * current trading day and its 16:00 ET close time without a timezone
 * library (`luxon` is not a web dependency). DST is handled by reading
 * `Intl.DateTimeFormat`'s offset for the zone at the instant in question
 * rather than hardcoding a UTC offset.
 */

const DEFAULT_ZONE = "America/New_York";

/** Groups items by a derived key (e.g. ticker), preserving input order within each group. */
export function groupByTicker<T>(items: readonly T[], getKey: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

/** Counts items for which `isOpen` is true (e.g. today's open contracts for a ticker). */
export function countOpen<T>(items: readonly T[], isOpen: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (isOpen(item)) {
      count += 1;
    }
  }
  return count;
}

/**
 * The earliest `closeTs` (Unix seconds) among `items` for which `isOpen` is
 * true, or `undefined` if none are open. Each market records its own real
 * `close_ts` on chain; the ticker-card countdown must use the actual
 * earliest one among that ticker's currently-open markets, not a
 * reconstructed 16:00 ET value, since a market's close time need not be
 * exactly 16:00 ET (e.g. an early-close trading day).
 */
export function earliestCloseTs<T>(
  items: readonly T[],
  isOpen: (item: T) => boolean,
  getCloseTs: (item: T) => bigint,
): number | undefined {
  let earliest: bigint | undefined;
  for (const item of items) {
    if (!isOpen(item)) {
      continue;
    }
    const closeTs = getCloseTs(item);
    if (earliest === undefined || closeTs < earliest) {
      earliest = closeTs;
    }
  }
  return earliest === undefined ? undefined : Number(earliest);
}

type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function readParts(ms: number, zone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const lookup: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") {
      lookup[part.type] = part.value;
    }
  }
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

/**
 * The difference, in minutes, between `zone`'s wall clock and UTC at instant
 * `ms`: `Date.UTC(wallClockAt(ms, zone)) - ms`, divided into minutes. Negative
 * for zones west of UTC (e.g. -240 for EDT, -300 for EST).
 */
function offsetMinutesAt(ms: number, zone: string): number {
  const p = readParts(ms, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - ms) / 60_000;
}

/**
 * Today's trading day, as `YYYYMMDD` in `zone` (America/New_York by default),
 * matching `Market.trading_day`'s encoding (data-model.md).
 */
export function todayTradingDay(now: number | Date = Date.now(), zone: string = DEFAULT_ZONE): number {
  const ms = now instanceof Date ? now.getTime() : now;
  const p = readParts(ms, zone);
  return p.year * 10_000 + p.month * 100 + p.day;
}

/**
 * Unix seconds for `hour:minute:00` `zone`-local time on `day` (`YYYYMMDD`),
 * DST-aware (R9). `day` is decomposed with no implied UTC offset; the
 * actual offset is read from `Intl` for the calendar day in question,
 * which is safe for both the 16:00 close and the 09:30 open since the US
 * DST transition happens at 02:00 local time, far from either.
 */
function tsForWallClockOnDay(day: number, hour: number, minute: number, zone: string): number {
  const year = Math.floor(day / 10_000);
  const month = Math.floor((day % 10_000) / 100);
  const date = day % 100;

  const naiveUtcMs = Date.UTC(year, month - 1, date, hour, minute, 0);
  const offsetMin = offsetMinutesAt(naiveUtcMs, zone);
  const targetMs = naiveUtcMs - offsetMin * 60_000;

  // Re-derive the offset at the corrected instant; if it differs (only
  // possible immediately around a DST transition, which never coincides
  // with 16:00/09:30 local under US rules), recompute once more against
  // the confirmed offset.
  const confirmedOffsetMin = offsetMinutesAt(targetMs, zone);
  const finalMs = confirmedOffsetMin === offsetMin ? targetMs : naiveUtcMs - confirmedOffsetMin * 60_000;

  return Math.floor(finalMs / 1000);
}

/**
 * Unix seconds for 16:00:00 `zone`-local time (America/New_York by default)
 * on `day` (`YYYYMMDD`), DST-aware (R9).
 */
export function closeTsForDay(day: number, zone: string = DEFAULT_ZONE): number {
  return tsForWallClockOnDay(day, 16, 0, zone);
}

/**
 * Unix seconds for 09:30:00 `zone`-local time (America/New_York by default)
 * on `day` (`YYYYMMDD`), DST-aware (R9) -- the regular session open, used by
 * the price-history backfill to pick a from-timestamp.
 */
export function openTsForDay(day: number, zone: string = DEFAULT_ZONE): number {
  return tsForWallClockOnDay(day, 9, 30, zone);
}

/** True when `day` (`YYYYMMDD`) falls on a Saturday or Sunday, by plain calendar date (no timezone, no holiday calendar). */
function isWeekendDay(day: number): boolean {
  const year = Math.floor(day / 10_000);
  const month = Math.floor((day % 10_000) / 100);
  const date = day % 100;
  const dow = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return dow === 0 || dow === 6;
}

/** The calendar day (`YYYYMMDD`) immediately before `day`, by plain calendar date. */
function previousCalendarDay(day: number): number {
  const year = Math.floor(day / 10_000);
  const month = Math.floor((day % 10_000) / 100);
  const date = day % 100;
  const prev = new Date(Date.UTC(year, month - 1, date - 1));
  return prev.getUTCFullYear() * 10_000 + (prev.getUTCMonth() + 1) * 100 + prev.getUTCDate();
}

/**
 * The trading day (`YYYYMMDD`) whose regular session the price-history
 * backfill should show: today's trading day in `zone`, unless that falls
 * on a weekend or before today's 09:30 open, in which case the most recent
 * weekday before it (no NYSE holiday calendar; a holiday just shows its
 * own empty/closed session, same as today's markets UI does elsewhere).
 */
export function currentSessionDay(now: number | Date = Date.now(), zone: string = DEFAULT_ZONE): number {
  const ms = now instanceof Date ? now.getTime() : now;
  let day = todayTradingDay(ms, zone);
  while (isWeekendDay(day)) {
    day = previousCalendarDay(day);
  }
  if (ms < openTsForDay(day, zone) * 1_000) {
    day = previousCalendarDay(day);
    while (isWeekendDay(day)) {
      day = previousCalendarDay(day);
    }
  }
  return day;
}

/**
 * The `[from, to]` Unix-second window (and its trading day) for the
 * price-history backfill: `currentSessionDay`'s 09:30 ET open through
 * either now (today's still-open session) or that day's 16:00 ET close
 * (a past session, so its tail is capped rather than running off into
 * whatever gap -- a weekend, a holiday -- separates it from `now`).
 */
export function currentSessionWindow(
  now: number | Date = Date.now(),
  zone: string = DEFAULT_ZONE,
): { day: number; from: number; to: number } {
  const ms = now instanceof Date ? now.getTime() : now;
  const nowSeconds = Math.floor(ms / 1_000);
  const day = currentSessionDay(ms, zone);
  const from = openTsForDay(day, zone);
  const isToday = day === todayTradingDay(ms, zone);
  const to = isToday ? Math.max(from, nowSeconds) : closeTsForDay(day, zone);
  return { day, from, to };
}

/**
 * "4:00 PM ET" for a close timestamp (Unix seconds), `zone`-local
 * (America/New_York by default). Used for the Markets page's settled-day
 * summary and settlement labels; always says "ET" regardless of the
 * zone's current EST/EDT offset, matching the product's own convention
 * (REVAMP_PLAN.md: "closes at 4:00 PM ET").
 */
export function formatCloseTimeEt(closeTs: number, zone: string = DEFAULT_ZONE): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${formatter.format(new Date(closeTs * 1000))} ET`;
}

/**
 * The `count` strikes (default 3) whose `strike` is nearest `liveMicro` by
 * absolute distance, ties broken toward the lower strike, returned sorted
 * by strike ascending (so callers render a normal ladder, not a
 * distance-sorted list). With no live price yet, falls back to the middle
 * of the ladder so the Markets page still shows something plausible while
 * waiting for the first price fetch. Used by the Markets page's ticker
 * cards and featured ladder to show only the strikes near the money.
 */
export function nearestStrikes<T extends { strike: bigint }>(
  items: readonly T[],
  liveMicro: bigint | undefined,
  count = 3,
): T[] {
  if (items.length === 0) {
    return [];
  }
  const sorted = [...items].sort((a, b) => (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0));

  if (liveMicro === undefined) {
    const mid = Math.floor(sorted.length / 2);
    const start = Math.max(0, Math.min(sorted.length - count, mid - Math.floor(count / 2)));
    return sorted.slice(Math.max(0, start), start + count);
  }

  const withDistance = sorted.map((item, index) => ({
    item,
    index,
    distance: item.strike > liveMicro ? item.strike - liveMicro : liveMicro - item.strike,
  }));
  withDistance.sort((a, b) => {
    if (a.distance !== b.distance) {
      return a.distance < b.distance ? -1 : 1;
    }
    return a.index - b.index;
  });
  const picked = withDistance.slice(0, count).map((w) => w.item);
  return picked.sort((a, b) => (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0));
}

/**
 * True when `closeTs` is still in the future but within `thresholdSeconds`
 * (default 30 minutes) of `now` -- drives the Markets page countdown
 * chip's warning colour (REVAMP_PLAN.md Wave R2: "turns warning-coloured
 * under 30 minutes"). False once `closeTs` has already passed; the
 * "Closed, settling…" pending chip takes over at that point instead.
 */
export function isCountdownUrgent(now: number, closeTs: number, thresholdSeconds = 1_800): boolean {
  const remaining = closeTs - now;
  return remaining > 0 && remaining <= thresholdSeconds;
}

/** The result of splitting a ticker's strikes into still-open and already-settled groups (`groupStrikesBySettlement`). */
export type StrikeGroups<T> = {
  open: T[];
  settled: T[];
  /** True once every strike in the input has settled (so a caller should skip the open/settled split entirely and just show the full, already-sorted list). */
  allSettled: boolean;
};

/**
 * Splits a ticker's strikes into open and settled groups, each sorted by
 * strike ascending. Used by the Trade page's strike list (T065 follow-up)
 * so settled rows ("Yes won"/"No won") don't sit interleaved with open
 * ones, which reads as if an open market had already been decided.
 * `allSettled` is true only when there's at least one strike and every one
 * of them has settled, letting the caller render the plain, undivided list
 * it already shows once the trading day is fully done.
 */
export function groupStrikesBySettlement<T extends { state: "open" | "settled"; strike: bigint }>(
  markets: readonly T[],
): StrikeGroups<T> {
  const sortByStrike = (a: T, b: T) => (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0);
  const open: T[] = [];
  const settled: T[] = [];
  for (const market of markets) {
    (market.state === "settled" ? settled : open).push(market);
  }
  return {
    open: open.sort(sortByStrike),
    settled: settled.sort(sortByStrike),
    allSettled: markets.length > 0 && settled.length === markets.length,
  };
}

export type TickerLifecycle = "none" | "open" | "pending" | "settled";

/**
 * A ticker's overall state on the Markets page, from its today's markets:
 * "none" with no markets at all, "settled" once every one of them has
 * settled, "pending" once every open one has passed its own `closeTs` but
 * at least one is still unsettled (the "Closed, settling…" chip), else
 * "open" (the countdown chip).
 */
export function tickerLifecycle(
  markets: readonly { state: "open" | "settled"; closeTs: bigint }[],
  now: number,
): TickerLifecycle {
  if (markets.length === 0) {
    return "none";
  }
  if (markets.every((m) => m.state === "settled")) {
    return "settled";
  }
  const anyOpenBeforeClose = markets.some((m) => m.state === "open" && now < Number(m.closeTs));
  return anyOpenBeforeClose ? "open" : "pending";
}
