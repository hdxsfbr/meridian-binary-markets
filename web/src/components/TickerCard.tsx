import Link from "next/link";
import { formatUsd } from "@/lib/format";
import { Countdown } from "./Countdown";
import type { Ticker } from "@meridian/sdk";

export type TickerCardProps = {
  ticker: Ticker;
  /** Last observed price, micro-USD; absent until the first price fetch resolves. */
  priceMicro?: bigint;
  /** Count of today's open contracts (strikes) for this ticker. */
  openCount: number;
  /**
   * Earliest `closeTs` (Unix seconds) among this ticker's open markets
   * today; `undefined` when there is no open market to count down to.
   */
  closeTs?: number;
};

/** One ticker's summary card on the Markets page: last price, open contracts, time to close. */
export function TickerCard({ ticker, priceMicro, openCount, closeTs }: TickerCardProps) {
  return (
    <Link
      href={`/trade/${ticker}`}
      className="block rounded border border-black/10 p-4 hover:border-black/30"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-semibold">{ticker}</span>
        <span>{priceMicro !== undefined ? formatUsd(priceMicro) : "—"}</span>
      </div>
      <div className="mt-2 flex items-baseline justify-between text-sm text-black/70">
        <span>
          {openCount} open contract{openCount === 1 ? "" : "s"} today
        </span>
        {closeTs !== undefined ? <Countdown closeTs={closeTs} /> : null}
      </div>
    </Link>
  );
}
