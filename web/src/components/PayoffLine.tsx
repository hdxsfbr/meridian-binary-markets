import { formatStrike, formatUsd } from "@/lib/format";

export type PayoffLineProps = {
  ticker: string;
  strike: bigint;
  /** What the holder pays for one contract, in micro-USDC. */
  cost: bigint;
};

/** Renders "You pay $X. You win $1.00 if META closes at or above $680." */
export function PayoffLine({ ticker, strike, cost }: PayoffLineProps) {
  return (
    <p>
      You pay {formatUsd(cost)}. You win $1.00 if {ticker} closes at or above {formatStrike(strike)}.
    </p>
  );
}
