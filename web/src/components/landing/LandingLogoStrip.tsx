"use client";

import Link from "next/link";
import { TICKERS } from "@meridian/sdk";
import { formatUsd } from "@/lib/format";
import { usePrices } from "@/hooks/usePrices";
import { useConfig } from "@/hooks/useConfig";
import { TickerMark } from "@/components/TickerMark";

/**
 * Logo strip under the hero: the enabled tickers' marks and live prices in
 * a slow infinite marquee, reusing the nav's `.ticker-tape` CSS (same
 * pause-on-hover/focus behaviour, globals.css) at a larger 40px chip size.
 */
export function LandingLogoStrip() {
  const prices = usePrices();
  const config = useConfig();
  const tickers = config?.tickers ?? TICKERS;

  return (
    <div className="ticker-tape border-y border-border bg-surface/40 py-5" aria-label="Live ticker prices">
      <div className="ticker-tape-track">
        {[0, 1].map((copy) => (
          <div key={copy} className="ticker-tape-group" aria-hidden={copy === 1}>
            {tickers.map((ticker) => (
              <Link
                key={`${copy}-${ticker}`}
                href={`/trade/${ticker}`}
                tabIndex={copy === 1 ? -1 : undefined}
                className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-sm text-text-muted hover:border-indigo/60 hover:text-text"
              >
                <TickerMark ticker={ticker} size={40} />
                <span className="font-medium">{ticker}</span>
                <span className="num">{prices[ticker] ? formatUsd(prices[ticker]!.priceMicro) : "—"}</span>
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
