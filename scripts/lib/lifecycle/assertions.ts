/**
 * Small assertion helpers for `scripts/lifecycle.ts` (tasks.md T086): exact
 * equality checks against the hand-computed deltas in `./trading-math.ts`,
 * throwing with both the expected and actual values on mismatch so a
 * failed lifecycle run points straight at which step went wrong.
 */

export function assertEqualBigint(actual: bigint, expected: bigint, label: string): void {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${label}: expected ${expected}, got ${actual} (diff ${actual - expected})`);
  }
}

export function assertAtLeast(actual: bigint, min: bigint, label: string): void {
  if (actual < min) {
    throw new Error(`assertion failed: ${label}: expected >= ${min}, got ${actual}`);
  }
}

export function assertTrue(cond: boolean, label: string): void {
  if (!cond) {
    throw new Error(`assertion failed: ${label}`);
  }
}
