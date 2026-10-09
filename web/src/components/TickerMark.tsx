import type { Ticker } from "@meridian/sdk";
import { TICKER_COLORS, TICKER_MARKS } from "@/lib/ticker-marks";

export type TickerMarkProps = {
  ticker: Ticker;
  /** Chip diameter in px. */
  size?: number;
};

/**
 * A round chip carrying a ticker's equity logo mark (Markets cards, the
 * Trade header, the nav ticker tape, Portfolio and History rows). The mark
 * itself is `aria-hidden`; the ticker text placed next to it by the caller
 * remains the accessible label. Unknown tickers (no entry in
 * `TICKER_MARKS`, e.g. the ETF fallbacks QQQ/VOO/SPY, or AMZN -- Simple
 * Icons ships no Amazon mark) fall back to the first two letters in mono.
 */
export function TickerMark({ ticker, size = 28 }: TickerMarkProps) {
  const svg = TICKER_MARKS[ticker];
  const color = TICKER_COLORS[ticker];
  const iconSize = Math.round(size * 0.64);

  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-surface-raised"
      style={{ width: size, height: size, color }}
    >
      {svg !== undefined ? (
        <span
          className="flex items-center justify-center"
          style={{ width: iconSize, height: iconSize }}
          // eslint-disable-next-line react/no-danger -- inlined build-time SVG from src/lib/ticker-marks.ts, not user input
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <span className="font-mono text-[0.6em] font-medium leading-none" style={{ fontSize: size * 0.34 }}>
          {ticker.slice(0, 2)}
        </span>
      )}
    </span>
  );
}
