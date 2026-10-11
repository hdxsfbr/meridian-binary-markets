/**
 * Pure view-model helpers for `/admin` (T074): which markets are unsettled
 * after close, when an admin override becomes available for each, how to
 * merge the automation service's `GET /status` map onto them by market
 * pubkey, and ET time formatting via `Intl` (no timezone library, matching
 * `web/src/lib/markets.ts`'s approach).
 *
 * Nothing here touches the network or React; `useStatus.ts`/`admin/page.tsx`
 * own the fetching and wiring.
 */

import { strikeStepFor } from "@meridian/sdk";

const DEFAULT_ZONE = "America/New_York";

/** The minimal shape of a decoded `Market` this module needs (a subset of `MarketAccount`). */
export type UnsettledCandidate = {
  pubkey: string;
  ticker: string;
  strike: bigint;
  closeTs: number;
  state: "open" | "settled";
};

export type UnsettledMarket = {
  pubkey: string;
  ticker: string;
  strike: bigint;
  closeTs: number;
  /** Seconds the market has been closed as of `now` (never negative). */
  closedForSecs: number;
};

/**
 * Markets that are still `open` but whose `closeTs` has already passed as of
 * `now` (Unix seconds) — the set the admin page's "Unsettled markets" table
 * shows. Settled markets and markets not yet closed are excluded.
 */
export function unsettledAfterClose<T extends UnsettledCandidate>(markets: readonly T[], now: number): UnsettledMarket[] {
  const out: UnsettledMarket[] = [];
  for (const m of markets) {
    if (m.state !== "open") {
      continue;
    }
    if (m.closeTs > now) {
      continue;
    }
    out.push({
      pubkey: m.pubkey,
      ticker: m.ticker,
      strike: m.strike,
      closeTs: m.closeTs,
      closedForSecs: now - m.closeTs,
    });
  }
  return out;
}

export type OverrideAvailability = {
  /** Unix seconds at which `admin_settle_override` stops refusing with `OverrideTooEarly`. */
  availableAt: number;
  /** Whether `now >= availableAt`. */
  available: boolean;
  /** Seconds remaining until `availableAt` (0 once available). */
  secondsRemaining: number;
};

/**
 * Mirrors `admin_settle_override`'s own guard exactly: `now >= close_ts +
 * overrideDelaySecs` (`programs/meridian/src/instructions/admin_settle_override.rs`).
 */
export function overrideAvailability(closeTs: number, overrideDelaySecs: number, now: number): OverrideAvailability {
  const availableAt = closeTs + overrideDelaySecs;
  const secondsRemaining = Math.max(0, availableAt - now);
  return {
    availableAt,
    available: now >= availableAt,
    secondsRemaining,
  };
}

/** One entry of the automation service's `GET /status` `markets` map (contracts/automation.md). */
export type StatusEntry = {
  ticker: string;
  strike: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: number | null;
  nextRetryAt: number | null;
  overrideAvailableAt: number | null;
  settled: boolean;
};

export type StatusMap = Record<string, StatusEntry>;

export type MergedMarketRow = UnsettledMarket & {
  /** `undefined` when the status service has no entry for this market (keyed by pubkey). */
  status: StatusEntry | undefined;
};

/**
 * Merges `unsettled` with `statusMap` by market pubkey (the status map's own
 * keys). Markets with no matching status entry keep `status: undefined`, so
 * the caller can render "Status unavailable" per market, not just globally
 * (the status fetch as a whole may have succeeded while this particular
 * market just isn't in the map yet).
 */
export function mergeStatus(unsettled: readonly UnsettledMarket[], statusMap: StatusMap | null): MergedMarketRow[] {
  return unsettled.map((m) => ({
    ...m,
    status: statusMap ? statusMap[m.pubkey] : undefined,
  }));
}

/** `Settled-by-override` badge entries, filtered from a full market list. */
export function settledByOverride<T extends { pubkey: string; ticker: string; strike: bigint; settledByOverride: boolean; state: "open" | "settled" }>(
  markets: readonly T[],
): T[] {
  return markets.filter((m) => m.state === "settled" && m.settledByOverride);
}

/**
 * Formats a Unix-seconds instant as `America/New_York` wall-clock time, e.g.
 * `"4:00:30 PM ET"`. Used for the override-enable time and closed-since
 * timestamps shown on the admin page (contracts/frontend.md: "the enable
 * time shown in ET").
 */
export function formatEt(unixSeconds: number, zone: string = DEFAULT_ZONE): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  return `${formatter.format(new Date(unixSeconds * 1000))} ET`;
}

/**
 * Plain-language labels for the four on-chain settlement guards, shown
 * collapsed under "Settlement checks" on `/admin` (REVAMP_PLAN Wave R5
 * copy audit). Each converts the raw on-chain unit (seconds, basis points)
 * into a label a non-operator can read without knowing the implementation.
 */

/** "Price no older than 5 min" / "...45s" -- whole minutes render as minutes, otherwise seconds. */
export function stalenessLabel(maxStalenessSecs: number): string {
  return `Price no older than ${minutesOrSeconds(maxStalenessSecs)}`;
}

/** "Confidence within 0.25%" from basis points (1 bps = 0.01%). */
export function confidenceLabel(maxConfBps: number): string {
  const pct = maxConfBps / 100;
  const text = Number.isInteger(pct) ? String(pct) : trimTrailingZeros(pct.toFixed(2));
  return `Confidence within ${text}%`;
}

/** "Price published at or after close" when the offset is 0, else "...up to 60s before close". */
export function publishOffsetLabel(minPublishOffsetSecs: number): string {
  if (minPublishOffsetSecs <= 0) {
    return "Price published at or after close";
  }
  return `Price published up to ${minPublishOffsetSecs}s before close`;
}

/** "Override allowed 1 h after close" from the override delay in seconds. */
export function overrideDelayLabel(overrideDelaySecs: number): string {
  return `Override allowed ${hoursOrMinutesOrSeconds(overrideDelaySecs)} after close`;
}

function minutesOrSeconds(totalSeconds: number): string {
  if (totalSeconds > 0 && totalSeconds % 60 === 0) {
    return `${totalSeconds / 60} min`;
  }
  return `${totalSeconds}s`;
}

function hoursOrMinutesOrSeconds(totalSeconds: number): string {
  if (totalSeconds > 0 && totalSeconds % 3600 === 0) {
    return `${totalSeconds / 3600} h`;
  }
  return minutesOrSeconds(totalSeconds);
}

function trimTrailingZeros(value: string): string {
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

/** Plain-language price source for `Config.oracleProvider` (REVAMP_PLAN Wave R5 copy audit). */
export function oracleProviderLabel(value: Record<string, unknown> | undefined): string {
  if (!value) {
    return "Price source: unknown";
  }
  if ("mockPyth" in value) {
    return "Price source: test publisher";
  }
  if ("pythReceiver" in value) {
    return "Price source: Pyth";
  }
  return "Price source: unknown";
}

/** Why an open strike cannot be adjusted (removed-then-recreated) right now. */
export type StrikeLockReason = "minted" | "orders" | "closed";

export type StrikeAdjustability = { adjustable: true; reason: null } | { adjustable: false; reason: StrikeLockReason };

/**
 * Whether an open strike is adjustable: not yet past its close time, zero
 * pairs outstanding (nothing minted), and no resting bids/asks (nothing on
 * the book). The close-time check comes first and mirrors the trap a market
 * whose `closeTs` has already passed can otherwise fall into: the market is
 * still `Open` on chain (nothing settles it automatically), so `removeStrike`
 * would succeed, but `addStrike`'s `create_market`/`add_strike` call refuses
 * a `closeTs` that is not in the future -- leaving the admin with the old
 * strike gone and no way to create the replacement. The pairs/book checks
 * mirror `remove_strike`'s own on-chain guards exactly (admin-tx.ts's
 * `removeStrike` doc comment) -- this function does not call any instruction,
 * it just decides, from data the admin page already has
 * (`MarketAccount.closeTs`/`pairsOutstanding`, `useBook`'s bid/ask counts),
 * whether to offer the "Adjust" control instead of sending a doomed
 * transaction and letting the program reject it.
 */
export function strikeAdjustability(
  pairsOutstanding: bigint,
  bidCount: number,
  askCount: number,
  closeTs: number,
  now: number,
): StrikeAdjustability {
  if (closeTs <= now) {
    return { adjustable: false, reason: "closed" };
  }
  if (pairsOutstanding > 0n) {
    return { adjustable: false, reason: "minted" };
  }
  if (bidCount > 0 || askCount > 0) {
    return { adjustable: false, reason: "orders" };
  }
  return { adjustable: true, reason: null };
}

/** Plain-language copy for `StrikeLockReason` (no "resting"/"minted"-as-jargon -- see copy rules in task brief). */
export function strikeLockReasonLabel(reason: StrikeLockReason): string {
  switch (reason) {
    case "minted":
      return "Locked: contracts have been minted";
    case "orders":
      return "Locked: orders are on the book";
    case "closed":
      return "Locked: trading has closed for today";
  }
}

/** The on-chain `u64` ceiling every strike (a `u64` lamport-style micro-USD field) must fit under. */
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * A human cap well under `U64_MAX`: no equity or crypto ticker this product
 * lists is anywhere near $10,000,000, so a strike above this is a mistake
 * (e.g. a misplaced decimal), not a legitimate value. Checked first because
 * it is the bound an admin will actually hit; `U64_MAX` is the on-chain
 * bound this never gets close to, kept as an explicit belt-and-suspenders
 * check rather than relying on the human cap alone.
 */
const MAX_STRIKE_MICRO = 10_000_000n * 1_000_000n;

/**
 * Validates a candidate new strike for "Add strike"/the "Adjust" flow's
 * inline input: positive, no larger than the on-chain `u64` can hold or than
 * a sane dollar cap, on the ticker's grid (`strikeStepFor`,
 * `packages/sdk/src/strikes.ts`), and not already one of `existingStrikes`
 * (every strike currently listed for this ticker/trading day, including the
 * one being removed when this is called for "Adjust" -- the new strike must
 * differ from every listed strike, not just the one going away). Returns an
 * error string to show the admin, or `null` when the strike is valid.
 *
 * The bounds checks run before the grid check and, critically, before any
 * transaction is sent: `admin/page.tsx` calls this for both "Add strike" and
 * "Adjust" before building any instruction, so a value this rejects never
 * reaches `removeStrike`/`addStrike` (and `adjustStrike` re-checks it too, as
 * a second line of defense -- see `admin-tx.ts`).
 */
export function validateNewStrike(strikeMicro: bigint, existingStrikes: readonly bigint[]): string | null {
  if (strikeMicro <= 0n) {
    return "Enter a strike greater than $0.";
  }
  if (strikeMicro > U64_MAX || strikeMicro > MAX_STRIKE_MICRO) {
    return "That strike is too large.";
  }
  const step = strikeStepFor(strikeMicro);
  if (strikeMicro % step !== 0n) {
    return `Enter a strike on the $${(step / 1_000_000n).toString()} grid.`;
  }
  if (existingStrikes.includes(strikeMicro)) {
    return "That strike is already listed.";
  }
  return null;
}

/** Formats a duration in whole seconds as "3h 12m" / "5m 03s" / "42s", for "closed since" cells. */
export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs.toString().padStart(2, "0")}s`;
  }
  return `${secs}s`;
}
