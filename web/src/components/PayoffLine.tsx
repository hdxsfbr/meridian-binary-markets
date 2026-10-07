import { formatStrike, formatUsd } from "@/lib/format";

export type PayoffLineProps = {
  ticker: string;
  strike: bigint;
  /** What the holder pays for one contract, in micro-USDC. */
  cost: bigint;
};

/**
 * Renders "You pay $X. You win $1.00 if META closes at or above $680."
 * With no offer on the book (`cost` is 0) the price clause is replaced by
 * "No offers yet" rather than quoting $0.00.
 */
export function PayoffLine({ ticker, strike, cost }: PayoffLineProps) {
  const lead = cost > 0n ? `You pay ${formatUsd(cost)}.` : "No offers yet.";
  return (
    <p>
      {lead} You win $1.00 if {ticker} closes at or above {formatStrike(strike)}.
    </p>
  );
}
