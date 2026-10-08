/**
 * Money and time formatting helpers for the web app. Every money value on
 * the wire is a bigint in micro-units (6 decimals); these helpers never
 * convert through `number`/float for anything that represents money.
 */

const ONE_USDC = 1_000_000n;

/** Formats a micro-USD/USDC bigint as a dollar string, e.g. 650000n -> "$0.65". */
export function formatUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / ONE_USDC;
  const fraction = abs % ONE_USDC;
  const cents = fraction / 10_000n; // two decimal places
  const centsStr = cents.toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole.toString()}.${centsStr}`;
}

/** Formats a Yes/No order-book price (micro-USDC per token) the same way as `formatUsd`. */
export function formatPrice(micro: bigint): string {
  return formatUsd(micro);
}

/** Implied probability for a Yes price in micro-USDC, e.g. 650000n -> "65%". */
export function impliedProbability(yesPriceMicro: bigint): string {
  const abs = yesPriceMicro < 0n ? -yesPriceMicro : yesPriceMicro;
  const pct = (abs * 100n) / ONE_USDC;
  return `${pct.toString()}%`;
}

/** The No-side price implied by a Yes price: `$1.00 - price`. */
export function oppositePrice(micro: bigint): bigint {
  return ONE_USDC - micro;
}

/**
 * Formats a strike (micro-USD) as a dollar amount: whole dollars when there is
 * no fractional part (680_000_000n -> "$680"), otherwise two decimal places
 * (680_500_000n -> "$680.50").
 */
export function formatStrike(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / ONE_USDC;
  const fraction = abs % ONE_USDC;
  if (fraction === 0n) {
    return `${negative ? "-" : ""}$${whole.toString()}`;
  }
  const cents = fraction / 10_000n; // two decimal places
  const centsStr = cents.toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole.toString()}.${centsStr}`;
}

/** Formats a countdown in whole seconds as "3h 12m" or, under a minute, "0m 45s". */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `0m ${secs}s`;
}

/**
 * Pure label logic for the market close countdown (contracts/frontend.md: "Awaiting
 * settlement (after 16:00, before the outcome): 'Settlement pending' with no reason
 * code"). Before `closeTs`, shows the remaining time. After `closeTs` and before an
 * outcome exists, shows "Settlement pending". Once `settled` is true, shows nothing
 * (the settled outcome is shown elsewhere, e.g. `ContractCard`).
 */
export function countdownLabel(now: number, closeTs: number, settled?: boolean): string | null {
  if (settled) {
    return null;
  }
  const remaining = closeTs - now;
  if (remaining <= 0) {
    return "Settlement pending";
  }
  return formatCountdown(remaining);
}

/** Trading day `YYYYMMDD` -> "2026-10-06". */
export function formatTradingDay(day: number): string {
  const year = Math.floor(day / 10_000);
  const month = Math.floor((day % 10_000) / 100);
  const date = day % 100;
  return `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

/**
 * "AAPL $330", or "AAPL $330 · 2026-10-08" when `markets` span more than one
 * trading day, so two ladders for the same ticker are tellable apart.
 */
export function marketOptionLabel(
  market: { ticker: string; strike: bigint; tradingDay?: number },
  markets: ReadonlyArray<{ tradingDay?: number }>,
): string {
  const base = `${market.ticker} ${formatStrike(market.strike)}`;
  const days = new Set(markets.map((m) => m.tradingDay).filter((d): d is number => d !== undefined));
  return days.size > 1 && market.tradingDay !== undefined ? `${base} · ${formatTradingDay(market.tradingDay)}` : base;
}
