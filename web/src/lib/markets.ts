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
 * Unix seconds for 16:00:00 `zone`-local time (America/New_York by default)
 * on `day` (`YYYYMMDD`), DST-aware (R9). `day` is decomposed with no implied
 * UTC offset; the actual offset is read from `Intl` for the calendar day in
 * question, which is safe here because the US DST transition happens at
 * 02:00 local time, far from 16:00.
 */
export function closeTsForDay(day: number, zone: string = DEFAULT_ZONE): number {
  const year = Math.floor(day / 10_000);
  const month = Math.floor((day % 10_000) / 100);
  const date = day % 100;

  const naiveUtcMs = Date.UTC(year, month - 1, date, 16, 0, 0);
  const offsetMin = offsetMinutesAt(naiveUtcMs, zone);
  const targetMs = naiveUtcMs - offsetMin * 60_000;

  // Re-derive the offset at the corrected instant; if it differs (only
  // possible immediately around a DST transition, which never coincides
  // with 16:00 local under US rules), recompute once more against the
  // confirmed offset.
  const confirmedOffsetMin = offsetMinutesAt(targetMs, zone);
  const finalMs = confirmedOffsetMin === offsetMin ? targetMs : naiveUtcMs - confirmedOffsetMin * 60_000;

  return Math.floor(finalMs / 1000);
}
