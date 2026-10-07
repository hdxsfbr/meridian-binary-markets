import { describe, expect, it } from "vitest";
import {
  STATIC_NYSE_HOLIDAYS,
  closeTs,
  earlyCloseTs,
  holidaysFromSchedule,
  isTradingDay,
  isWeekday,
  nextTradingDay,
  parsePythSchedule,
  staticHolidaysFor,
  tradingDayOf,
} from "../src/calendar";

// research.md R4 example, extended with the exceptions the brief asks us to assert on:
// Labor Day (full close), Thanksgiving (full close), the day after Thanksgiving (early
// close at 13:00 ET) and Christmas (full close).
const SCHEDULE_2026 =
  "America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300,1225/C";

function toUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

describe("closeTs", () => {
  it("is 20:00:00Z on a July trading day (EDT)", () => {
    expect(closeTs(20260706)).toBe(toUnix("2026-07-06T20:00:00.000Z"));
  });

  it("is 21:00:00Z on a December trading day (EST)", () => {
    expect(closeTs(20261207)).toBe(toUnix("2026-12-07T21:00:00.000Z"));
  });

  it("is DST-aware on the spring-forward boundary day (2026-03-08, EDT by 4pm)", () => {
    expect(closeTs(20260308)).toBe(toUnix("2026-03-08T20:00:00.000Z"));
  });

  it("is DST-aware on the fall-back boundary day (2026-11-01, EST by 4pm)", () => {
    expect(closeTs(20261101)).toBe(toUnix("2026-11-01T21:00:00.000Z"));
  });
});

describe("tradingDayOf", () => {
  it("round-trips through closeTs", () => {
    for (const day of [20260706, 20261207, 20260308, 20261101]) {
      // Sample a timestamp within the trading day (just before the close) and confirm it
      // maps back to the same YYYYMMDD.
      const ts = closeTs(day) - 60;
      expect(tradingDayOf(ts)).toBe(day);
    }
  });
});

describe("isWeekday / isTradingDay", () => {
  it("rejects weekends", () => {
    // 2026-10-10 is a Saturday, 2026-10-11 a Sunday.
    expect(isWeekday(20261010)).toBe(false);
    expect(isWeekday(20261011)).toBe(false);
    expect(isTradingDay(20261010, new Set())).toBe(false);
  });

  it("accepts an ordinary weekday", () => {
    // 2026-10-06 is a Tuesday.
    expect(isWeekday(20261006)).toBe(true);
    expect(isTradingDay(20261006, new Set())).toBe(true);
  });

  it("rejects a day from the static holiday list", () => {
    const holidays = staticHolidaysFor(2026);
    // 1126 = Thanksgiving 2026-11-26, a Thursday (would otherwise be a trading day).
    expect(isTradingDay(20261126, holidays)).toBe(false);
  });

  it("accepts YYYYMMDD-form holiday entries too", () => {
    const holidays = new Set(["20261006"]);
    expect(isTradingDay(20261006, holidays)).toBe(false);
  });
});

describe("nextTradingDay", () => {
  it("skips a weekend", () => {
    // 2026-10-09 is a Friday; the next trading day is Monday 2026-10-12.
    expect(nextTradingDay(20261009, new Set())).toBe(20261012);
  });

  it("skips a holiday that falls on a weekday", () => {
    const holidays = staticHolidaysFor(2026);
    // 2026-11-25 (Wed) -> next day 11-26 is Thanksgiving (holiday) -> 11-27 (Fri, trading).
    expect(nextTradingDay(20261125, holidays)).toBe(20261127);
  });
});

describe("parsePythSchedule", () => {
  it("parses the zone, weekly entries and exceptions", () => {
    const parsed = parsePythSchedule(SCHEDULE_2026);
    expect(parsed.zone).toBe("America/New_York");
    expect(parsed.weekly).toEqual([
      "0930-1600",
      "0930-1600",
      "0930-1600",
      "0930-1600",
      "0930-1600",
      "C",
      "C",
    ]);
    expect(parsed.exceptions.get("0907")).toBe("C");
    expect(parsed.exceptions.get("1126")).toBe("C");
    expect(parsed.exceptions.get("1127")).toBe("0930-1300");
    expect(parsed.exceptions.get("1225")).toBe("C");
  });

  it("yields the 1126/1225 holidays via holidaysFromSchedule", () => {
    const parsed = parsePythSchedule(SCHEDULE_2026);
    const holidays = holidaysFromSchedule(parsed);
    expect(holidays.has("1126")).toBe(true);
    expect(holidays.has("1225")).toBe(true);
    expect(holidays.has("0907")).toBe(true);
    // 1127 is an early close, not a full-day holiday.
    expect(holidays.has("1127")).toBe(false);
  });

  it("rejects a malformed schedule string", () => {
    expect(() => parsePythSchedule("not-a-schedule")).toThrow();
    expect(() => parsePythSchedule("America/New_York;0930-1600,C")).toThrow();
  });

  it("rejects an invalid IANA zone", () => {
    expect(() =>
      parsePythSchedule("Not/AZone;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;"),
    ).toThrow();
  });

  it("rejects fewer than 7 weekly entries", () => {
    expect(() =>
      parsePythSchedule("America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C;"),
    ).toThrow();
  });

  it("rejects an exception with an invalid month/day (2560)", () => {
    expect(() =>
      parsePythSchedule(
        "America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;2560/C",
      ),
    ).toThrow();
  });

  it("rejects an exception with an invalid clock value (0907/0930-2500)", () => {
    expect(() =>
      parsePythSchedule(
        "America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/0930-2500",
      ),
    ).toThrow();
  });

  it("still parses the R4 example", () => {
    expect(() => parsePythSchedule(SCHEDULE_2026)).not.toThrow();
  });
});

describe("staticHolidaysFor", () => {
  it("returns the 2026 holiday set", () => {
    expect(staticHolidaysFor(2026)).toEqual(new Set(STATIC_NYSE_HOLIDAYS[2026]));
  });

  it("throws for an unsupported year", () => {
    expect(() => staticHolidaysFor(2027)).toThrow();
  });
});

describe("earlyCloseTs", () => {
  it("is 18:00:00Z for the day after Thanksgiving 2026 (13:00 ET -> EST)", () => {
    const parsed = parsePythSchedule(SCHEDULE_2026);
    expect(earlyCloseTs(20261127, parsed)).toBe(toUnix("2026-11-27T18:00:00.000Z"));
  });

  it("returns null for a full holiday", () => {
    const parsed = parsePythSchedule(SCHEDULE_2026);
    expect(earlyCloseTs(20261126, parsed)).toBeNull();
  });

  it("returns null when there is no exception for that day", () => {
    const parsed = parsePythSchedule(SCHEDULE_2026);
    expect(earlyCloseTs(20261006, parsed)).toBeNull();
  });
});
