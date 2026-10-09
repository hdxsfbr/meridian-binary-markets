"use client";

import Link from "next/link";
import dynamic from "next/dynamic";

// Client-only: the button's label depends on browser wallet state (see Nav.tsx).
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);
import { TICKERS } from "@meridian/sdk";
import { formatUsd } from "@/lib/format";
import { PayoffLine } from "@/components/PayoffLine";
import { usePrices } from "@/hooks/usePrices";
import { useConfig } from "@/hooks/useConfig";
import { Card } from "@/components/ui/Card";
import { TickerMark } from "@/components/TickerMark";

/** Illustrative Yes price (65 cents) for the payoff-line example on the landing page. */
const EXAMPLE_YES_PRICE_MICRO = 650_000n;
const EXAMPLE_STRIKE_MICRO = 680_000_000n;

export default function Home() {
  const prices = usePrices();
  const config = useConfig();
  const tickers = config?.tickers ?? TICKERS;

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="h-1 w-24 rounded-full brand-gradient-rule" />
      <h1 className="mt-6 text-4xl font-semibold">Meridian</h1>

      <p className="mt-6 text-lg text-text-muted">
        Every contract pays out $1.00 to the side that wins. Buy Yes if you think a stock will close
        at or above a strike price by 4:00pm Eastern; buy No if you think it won&apos;t. Each contract
        costs less than $1.00 to buy and is worth exactly $1.00 if you&apos;re right, or nothing if
        you&apos;re wrong.
      </p>

      <Card className="mt-6 p-4">
        <PayoffLine ticker="META" strike={EXAMPLE_STRIKE_MICRO} cost={EXAMPLE_YES_PRICE_MICRO} />
      </Card>

      <h2 className="mt-10 text-xl font-semibold">Last prices</h2>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tickers.map((ticker) => (
          <Link key={ticker} href={`/trade/${ticker}`} className="block">
            <Card className="p-3 transition hover:border-indigo/60">
              <div className="flex items-center gap-2 font-semibold">
                <TickerMark ticker={ticker} size={24} />
                {ticker}
              </div>
              <div className="num mt-1">{prices[ticker] ? formatUsd(prices[ticker]!.priceMicro) : "—"}</div>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-10 flex items-center gap-4">
        <WalletMultiButton />
        <Link
          href="/markets"
          className="rounded-md bg-indigo px-4 py-2 text-sm font-medium text-on-brand hover:bg-indigo/80"
        >
          Browse markets
        </Link>
      </div>
    </div>
  );
}
