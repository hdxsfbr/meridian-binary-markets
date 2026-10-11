/**
 * Pricing for the daily demo quotes (`scripts/seed-daily.ts`): a two-sided Yes quote around a
 * rough probability that the stock closes at or above the strike, from the live price and a flat
 * daily volatility assumption. This is demo liquidity so a visitor sees a market, not a pricing
 * model; DECISIONS.md "Demo liquidity is seeded from a test wallet".
 */

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export interface QuotePlan {
  /** Probability the close is at or above the strike, 0..1. */
  probability: number;
  /** Bid and ask in micro-USDC, both inside [MIN_PRICE, MAX_PRICE]. */
  bidMicro: bigint;
  askMicro: bigint;
}

export const DAILY_VOL = 0.015; // 1.5 % one-day move, flat across the seven stocks
export const HALF_SPREAD = 0.03; // 3 cents each side
const MIN_PRICE = 0.05;
const MAX_PRICE = 0.95;

/** Bid/ask for Yes on `strike` given the live `price`; both in dollars. */
export function planQuote(price: number, strike: number, dailyVol = DAILY_VOL, halfSpread = HALF_SPREAD): QuotePlan {
  if (!(price > 0) || !(strike > 0)) throw new Error(`planQuote: price and strike must be positive, got ${price} / ${strike}`);
  const z = Math.log(price / strike) / dailyVol;
  const probability = normalCdf(z);
  const clamp = (v: number): number => Math.min(MAX_PRICE, Math.max(MIN_PRICE, v));
  const bid = clamp(probability - halfSpread);
  const ask = clamp(probability + halfSpread);
  const toMicro = (v: number): bigint => BigInt(Math.round(v * 100)) * 10_000n; // whole cents
  let bidMicro = toMicro(bid);
  let askMicro = toMicro(ask);
  if (askMicro <= bidMicro) {
    // Both sides hit the same clamp: keep the capped side and step the other one cent away,
    // so the quote never crosses or touches and stays inside the band.
    if (askMicro < toMicro(MAX_PRICE)) askMicro = bidMicro + 10_000n;
    else bidMicro = askMicro - 10_000n;
  }
  return { probability, bidMicro, askMicro };
}

/** The strike closest to `price` (ties go to the lower strike). */
export function nearestStrike(price: number, strikes: readonly number[]): number | undefined {
  let best: number | undefined;
  for (const s of strikes) {
    if (best === undefined || Math.abs(s - price) < Math.abs(best - price)) best = s;
  }
  return best;
}
