/**
 * Pure summary math for the "sub-second transaction finality" benchmark
 * (docs/PRD.md §7 "Performance benchmarks") -- `scripts/lifecycle.ts` times
 * every transaction it sends (`LifecycleChain.confirmationLatenciesMs`,
 * `chain.ts`'s `timeRpc`) from just before `.rpc()`/`sendRawTransaction` is
 * called to the moment it resolves with a confirmed signature, then hands
 * the resulting list here to produce one printable summary. No I/O, no
 * chain access, so it's exercised directly in
 * `scripts/test/latency.test.ts` without a validator.
 */

export interface LatencySummary {
  count: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * Linear-interpolation percentile over a copy of `sorted` (already
 * ascending), `p` in `[0, 1]`. Matches the common "nearest-rank with
 * interpolation" convention (e.g. numpy's default `linear` method) rather
 * than truncating to the nearest sample, so p95 of a small sample doesn't
 * silently collapse to the max.
 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    throw new Error("percentile: empty input");
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = p * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = rank - lowerIndex;
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
}

/**
 * Summarizes a run's per-transaction confirmation latencies (milliseconds)
 * into count/median/p95/max. Throws on an empty list -- "zero transactions
 * sent" is a caller bug (every lifecycle run sends at least one), not a
 * summary this function should silently paper over with NaN/zero.
 */
export function summarizeLatencies(latenciesMs: readonly number[]): LatencySummary {
  if (latenciesMs.length === 0) {
    throw new Error("summarizeLatencies: no latencies to summarize");
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

/** One-line rendering for `logDetail`, e.g. "count=42 median=410ms p95=980ms max=1240ms". */
export function formatLatencySummary(summary: LatencySummary): string {
  return `count=${summary.count} median=${Math.round(summary.medianMs)}ms p95=${Math.round(summary.p95Ms)}ms max=${Math.round(summary.maxMs)}ms`;
}
