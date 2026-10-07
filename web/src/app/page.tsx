"use client";

import Link from "next/link";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { TICKERS } from "@meridian/sdk";
import { formatUsd } from "@/lib/format";
import { PayoffLine } from "@/components/PayoffLine";
import { usePrices } from "@/hooks/usePrices";

/** Illustrative Yes price (65 cents) for the payoff-line example on the landing page. */
const EXAMPLE_YES_PRICE_MICRO = 650_000n;
const EXAMPLE_STRIKE_MICRO = 680_000_000n;

export default function Home() {
  const prices = usePrices();

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-4xl font-semibold">Meridian</h1>

      <p className="mt-6 text-lg">
        Every contract pays out $1.00 to the side that wins. Buy Yes if you think a stock will close
        at or above a strike price by 4:00pm Eastern; buy No if you think it won&apos;t. Each contract
        costs less than $1.00 to buy and is worth exactly $1.00 if you&apos;re right, or nothing if
        you&apos;re wrong.
      </p>

      <div className="mt-6 rounded border border-black/10 p-4">
        <PayoffLine ticker="META" strike={EXAMPLE_STRIKE_MICRO} cost={EXAMPLE_YES_PRICE_MICRO} />
      </div>

      <h2 className="mt-10 text-xl font-semibold">Last prices</h2>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {TICKERS.map((ticker) => (
          <div key={ticker} className="rounded border border-black/10 p-3">
            <div className="font-semibold">{ticker}</div>
            <div>{prices[ticker] ? formatUsd(prices[ticker]!.priceMicro) : "—"}</div>
          </div>
        ))}
      </div>

      <div className="mt-10 flex items-center gap-4">
        <WalletMultiButton />
        <Link href="/markets" className="underline">
          Browse markets
        </Link>
      </div>
    </div>
  );
}
