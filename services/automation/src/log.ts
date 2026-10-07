/**
 * Structured operator logging per contracts/automation.md "Logging":
 * JSON lines to stdout `{ts, job, ticker, market, step, ok, error?, sig?}`.
 * The History page never reads these; they are for the operator and the
 * demo video, so no implementation commentary belongs anywhere else.
 */

export interface LogEvent {
  job: string;
  ticker?: string;
  market?: string;
  step: string;
  ok: boolean;
  error?: string;
  sig?: string;
  [key: string]: unknown;
}

// JSON.stringify throws on bigint by default; render it as a decimal string instead so
// fields like on-chain amounts (bigint on the money path) can be logged directly.
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function line(event: LogEvent): string {
  return JSON.stringify({ ts: new Date().toISOString(), ...event }, jsonReplacer);
}

/** Writes one JSON line to stdout. */
export function log(event: LogEvent): void {
  process.stdout.write(line(event) + "\n");
}

/** Writes one JSON line to stderr (contracts/automation.md "Alert payload": also written at error level). */
export function logError(event: LogEvent): void {
  process.stderr.write(line(event) + "\n");
}
