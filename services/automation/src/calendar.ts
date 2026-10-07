/**
 * Trading-day and trading-calendar math for the mock price provider and the
 * settlement job (research.md R4, R9; tasks.md T044). The chain has no
 * timezone (R9): every ET conversion happens here, once, off chain, and the
 * program only ever sees a Unix timestamp or a `YYYYMMDD` trading day.
 *
 * `parsePythSchedule` reads the `schedule` string Pyth publishes alongside
 * each `Equity.US` feed (research.md R4), e.g.
 * `America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300`.
 * `STATIC_NYSE_HOLIDAYS` (via `staticHolidaysFor`) is the fallback when that string isn't
 * available (R9 "a fixed NYSE holiday list in config is the fallback").
 */

import { DateTime, IANAZone } from "luxon";

export const ET_ZONE = "America/New_York";

/**
 * Fallback NYSE full-day holidays, `MMDD`, keyed by year, verified against
 * the actual calendar (weekday-observed where a fixed holiday falls on a
 * weekend). 2026: New Year's Day (Thu Jan 1), MLK Day (3rd Mon), Presidents
 * Day (3rd Mon), Good Friday (Apr 3, Easter is Apr 5), Memorial Day (last
 * Mon of May), Juneteenth (Fri Jun 19, no shift needed), Independence Day
 * observed (Jul 4 falls on a Saturday, observed Fri Jul 3), Labor Day (1st
 * Mon of Sep), Thanksgiving (4th Thu of Nov), Christmas (Fri Dec 25, no
 * shift needed).
 */
export const STATIC_NYSE_HOLIDAYS: Record<number, string[]> = {
  2026: [
    "0101", // New Year's Day
    "0119", // Martin Luther King Jr. Day
    "0216", // Washington's Birthday / Presidents Day
    "0403", // Good Friday
    "0525", // Memorial Day
    "0619", // Juneteenth
    "0703", // Independence Day (observed)
    "0907", // Labor Day
    "1126", // Thanksgiving
    "1225", // Christmas Day
  ],
};

/**
 * The static NYSE holiday fallback for `year`, as a `Set<MMDD>`. Throws for
 * a year this module doesn't carry a fixed list for (R9: this is a fallback,
 * not a general calendar — an unsupported year should fail closed rather
 * than silently return an empty/wrong holiday set).
 */
export function staticHolidaysFor(year: number): Set<string> {
  const holidays = STATIC_NYSE_HOLIDAYS[year];
  if (!holidays) {
    throw new Error(`staticHolidaysFor: no static NYSE holiday list for year ${year}`);
  }
  return new Set(holidays);
}

function splitTradingDay(tradingDay: number): { year: number; month: number; day: number } {
  const s = String(tradingDay);
  if (!/^\d{8}$/.test(s)) {
    throw new Error(`splitTradingDay: expected YYYYMMDD, got ${tradingDay}`);
  }
  return {
    year: Number(s.slice(0, 4)),
    month: Number(s.slice(4, 6)),
    day: Number(s.slice(6, 8)),
  };
}

function mmdd(tradingDay: number): string {
  return String(tradingDay).slice(4, 8);
}

function tradingDayToDateTime(tradingDay: number): DateTime {
  const { year, month, day } = splitTradingDay(tradingDay);
  const dt = DateTime.fromObject({ year, month, day }, { zone: ET_ZONE });
  if (!dt.isValid) {
    throw new Error(`tradingDayToDateTime: invalid trading day ${tradingDay}: ${dt.invalidReason}`);
  }
  return dt;
}

/** 16:00:00 America/New_York on `tradingDay` (`YYYYMMDD`), DST-aware, as Unix seconds. */
export function closeTs(tradingDay: number): number {
  const dt = tradingDayToDateTime(tradingDay).set({ hour: 16, minute: 0, second: 0, millisecond: 0 });
  return Math.floor(dt.toSeconds());
}

/** The `YYYYMMDD` ET calendar day containing `unixSeconds`. */
export function tradingDayOf(unixSeconds: number): number {
  const dt = DateTime.fromSeconds(unixSeconds, { zone: ET_ZONE });
  return Number(dt.toFormat("yyyyMMdd"));
}

/** True if `day` (`YYYYMMDD`) falls on a Monday–Friday in ET, irrespective of holidays. */
export function isWeekday(day: number): boolean {
  const weekday = tradingDayToDateTime(day).weekday; // 1 = Monday .. 7 = Sunday
  return weekday >= 1 && weekday <= 5;
}

/**
 * True if `day` is a weekday and not in `holidays`. Holiday entries may be
 * `MMDD` (recurring/annual match) or `YYYYMMDD` (exact-date match); both
 * forms are checked.
 */
export function isTradingDay(day: number, holidays: Set<string>): boolean {
  if (!isWeekday(day)) return false;
  if (holidays.has(mmdd(day))) return false;
  if (holidays.has(String(day))) return false;
  return true;
}

/** The next trading day strictly after `day` (`YYYYMMDD`), skipping weekends and `holidays`. */
export function nextTradingDay(day: number, holidays: Set<string>): number {
  let dt = tradingDayToDateTime(day).plus({ days: 1 });
  for (let i = 0; i < 3650; i += 1) {
    const candidate = Number(dt.toFormat("yyyyMMdd"));
    if (isTradingDay(candidate, holidays)) {
      return candidate;
    }
    dt = dt.plus({ days: 1 });
  }
  throw new Error(`nextTradingDay: no trading day found within 10 years after ${day}`);
}

export type DaySchedule = string | "C";

export interface ParsedPythSchedule {
  zone: string;
  /** Monday .. Sunday, each `HHMM-HHMM` or `'C'` for closed. */
  weekly: DaySchedule[];
  /** Key is `MMDD`; value is `'C'` (closed) or `HHMM-HHMM` (early/late close). */
  exceptions: Map<string, DaySchedule>;
}

/** True if `hhmm` is a 4-digit clock value with a valid hour (00-23) and minute (00-59). */
function isValidClock(hhmm: string): boolean {
  if (!/^\d{4}$/.test(hhmm)) return false;
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2, 4));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/** True if `spec` is `'C'` or `HHMM-HHMM` with two valid clock values. */
function isValidDaySpec(spec: string): boolean {
  if (spec === "C") return true;
  const match = /^(\d{4})-(\d{4})$/.exec(spec);
  if (!match) return false;
  return isValidClock(match[1]) && isValidClock(match[2]);
}

/** True if `mmdd` is a 4-digit date with a valid month (01-12) and day (01-31) for that month. */
function isValidMonthDay(mmdd: string): boolean {
  if (!/^\d{4}$/.test(mmdd)) return false;
  const month = Number(mmdd.slice(0, 2));
  const day = Number(mmdd.slice(2, 4));
  if (month < 1 || month > 12) return false;
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb allows 29 (leap-safe).
  return day >= 1 && day <= daysInMonth[month - 1];
}

/**
 * Parses a Pyth feed `schedule` string (research.md R4):
 * `<zone>;<mon>,<tue>,<wed>,<thu>,<fri>,<sat>,<sun>;<MMDD>/<spec>,<MMDD>/<spec>,...`
 * where each `<spec>` is `C` or `HHMM-HHMM`. The exceptions segment may be
 * empty (no trailing exceptions at all). Validates the full grammar: the
 * zone must be a real IANA zone, there must be exactly 7 weekly entries each
 * a valid day spec, and each exception key/value must be a valid `MMDD` date
 * and a valid day spec respectively.
 */
export function parsePythSchedule(schedule: string): ParsedPythSchedule {
  const parts = schedule.split(";");
  if (parts.length < 2) {
    throw new Error(`parsePythSchedule: malformed schedule "${schedule}"`);
  }
  const [zone, weeklyPart, exceptionsPart] = parts;

  if (!IANAZone.isValidZone(zone)) {
    throw new Error(`parsePythSchedule: invalid IANA zone "${zone}" in "${schedule}"`);
  }

  const weekly = weeklyPart.split(",").map((entry) => entry.trim());
  if (weekly.length !== 7) {
    throw new Error(
      `parsePythSchedule: expected 7 weekly entries (Mon..Sun), got ${weekly.length} in "${schedule}"`,
    );
  }
  for (const entry of weekly) {
    if (!isValidDaySpec(entry)) {
      throw new Error(`parsePythSchedule: invalid weekly entry "${entry}" in "${schedule}"`);
    }
  }

  const exceptions = new Map<string, DaySchedule>();
  if (exceptionsPart && exceptionsPart.trim().length > 0) {
    for (const entry of exceptionsPart.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      const slash = trimmed.indexOf("/");
      if (slash === -1) {
        throw new Error(`parsePythSchedule: malformed exception entry "${trimmed}" in "${schedule}"`);
      }
      const key = trimmed.slice(0, slash);
      const value = trimmed.slice(slash + 1);
      if (!isValidMonthDay(key)) {
        throw new Error(`parsePythSchedule: malformed exception date "${key}" in "${schedule}"`);
      }
      if (!isValidDaySpec(value)) {
        throw new Error(`parsePythSchedule: invalid exception spec "${value}" for "${key}" in "${schedule}"`);
      }
      exceptions.set(key, value as DaySchedule);
    }
  }

  return { zone, weekly, exceptions };
}

/** The `MMDD` full-day holidays (exceptions whose value is `'C'`) from a parsed schedule. */
export function holidaysFromSchedule(parsed: ParsedPythSchedule): Set<string> {
  const holidays = new Set<string>();
  for (const [mmddKey, value] of parsed.exceptions) {
    if (value === "C") {
      holidays.add(mmddKey);
    }
  }
  return holidays;
}

/**
 * The early/late-close timestamp for `tradingDay` if the schedule's
 * exceptions list an `HHMM-HHMM` entry for its `MMDD` (e.g. `1127/0930-1300`
 * -> 13:00 ET the day after Thanksgiving). Returns `null` when there is no
 * exception for that day or the exception is a full closure (`'C'`).
 */
export function earlyCloseTs(tradingDay: number, parsed: ParsedPythSchedule): number | null {
  const key = mmdd(tradingDay);
  const entry = parsed.exceptions.get(key);
  if (!entry || entry === "C") {
    return null;
  }

  const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(entry);
  if (!match) {
    throw new Error(`earlyCloseTs: malformed exception spec "${entry}" for ${tradingDay}`);
  }
  const closeHour = Number(match[3]);
  const closeMinute = Number(match[4]);

  const dt = tradingDayToDateTime(tradingDay).set({
    hour: closeHour,
    minute: closeMinute,
    second: 0,
    millisecond: 0,
  });
  return Math.floor(dt.toSeconds());
}
