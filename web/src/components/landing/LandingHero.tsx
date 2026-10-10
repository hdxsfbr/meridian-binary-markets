"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { TICKERS, type Ticker } from "@meridian/sdk";
import { formatStrike } from "@/lib/format";
import { usePrices } from "@/hooks/usePrices";
import { useConfig } from "@/hooks/useConfig";
import { AuroraBackground } from "./AuroraBackground";
import { EXAMPLE_STRIKE_MICRO } from "./constants";

// Client-only: the button's label depends on browser wallet state (see Nav.tsx).
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

// Client-only: touches `window`/canvas via the dynamically-imported
// charting library (see HeroChart.tsx's own top-of-file note).
const HeroChart = dynamic(() => import("./HeroChart").then((m) => m.HeroChart), { ssr: false });

/** Plain-language company names for the headline ("Will Apple close above…"); the rest of the app shows tickers only. */
const TICKER_NAMES: Partial<Record<Ticker, string>> = {
  AAPL: "Apple",
  AMZN: "Amazon",
  GOOGL: "Google",
  META: "Meta",
  MSFT: "Microsoft",
  NVDA: "Nvidia",
  TSLA: "Tesla",
};

const CYCLE_MS = 6000;
const TEN_DOLLARS_MICRO = 10_000_000n;

/** Rounds a micro-USD price to the nearest $10, e.g. $337.40 -> $340. */
function roundToNearestTen(priceMicro: bigint): bigint {
  const half = TEN_DOLLARS_MICRO / 2n;
  return ((priceMicro + half) / TEN_DOLLARS_MICRO) * TEN_DOLLARS_MICRO;
}

/**
 * Full-viewport hero: aurora backdrop, a headline that cycles through the
 * enabled tickers every 6s (crossfade via a remount-triggered CSS fade,
 * `landing-fade-in`), and a real intraday chart for whichever ticker is
 * currently showing (`HeroChart`, loaded client-only since it touches the
 * charting library; falls back to the old synthetic `LiveChart` itself
 * when there's no session data yet). The strike in the headline comes
 * from the live price for whichever ticker is showing, rounded to the
 * nearest $10; before any price has loaded it falls back to the fixed
 * META $680 example shared with "How it works".
 */
export function LandingHero() {
  const prices = usePrices();
  const config = useConfig();
  const tickers = config?.tickers ?? TICKERS;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((i) => (i + 1) % tickers.length);
    }, CYCLE_MS);
    return () => clearInterval(interval);
  }, [tickers.length]);

  const ticker = tickers[index % tickers.length] ?? "META";
  const name = TICKER_NAMES[ticker] ?? ticker;
  const livePrice = prices[ticker]?.priceMicro;
  const strikeMicro = livePrice !== undefined ? roundToNearestTen(livePrice) : EXAMPLE_STRIKE_MICRO;
  const strikeLabel = formatStrike(strikeMicro);

  return (
    <section className="relative isolate flex min-h-[80vh] items-center overflow-hidden border-b border-border">
      <AuroraBackground />
      <div className="relative z-10 mx-auto grid w-full max-w-6xl gap-12 px-6 py-20 lg:grid-cols-2 lg:items-center">
        <div>
          <div className="h-1 w-24 rounded-full brand-gradient-rule" />
          <h1 className="mt-6 text-4xl font-semibold leading-tight sm:text-5xl">
            <span key={`${ticker}-name`} className="landing-fade-in block">
              Will {name}
            </span>
            <span key={`${ticker}-strike`} className="landing-fade-in block">
              close above {strikeLabel} today?
            </span>
          </h1>
          <p className="mt-6 max-w-md text-lg text-text-muted">
            Every contract pays out $1.00 to the side that wins.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href="/markets"
              className="rounded-md bg-indigo px-5 py-2.5 text-sm font-medium text-on-brand hover:bg-indigo/80"
            >
              Browse markets
            </Link>
            <WalletMultiButton />
          </div>
        </div>
        <div className="flex justify-center lg:justify-end">
          <HeroChart ticker={ticker} strikeMicro={strikeMicro} />
        </div>
      </div>
    </section>
  );
}
