"use client";

import type { CSSProperties, ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { PayoffLine } from "@/components/PayoffLine";
import { formatUsd } from "@/lib/format";
import { useReveal } from "./useReveal";
import { useCountUp } from "./useCountUp";
import { EXAMPLE_STRIKE_MICRO, EXAMPLE_YES_PRICE_MICRO } from "./constants";

const LADDER_ROWS: ReadonlyArray<{ strike: string; chance: number; atMoney?: boolean }> = [
  { strike: "$330", chance: 72 },
  { strike: "$340", chance: 55, atMoney: true },
  { strike: "$350", chance: 31 },
];

type StepCardProps = {
  index: number;
  title: string;
  description: string;
  children: ReactNode;
};

/**
 * One "how it works" card: fades and rises into view the first time it
 * crosses the viewport (`useReveal`), staggered 100ms per card index. The
 * reveal state lives on the wrapper so CSS descendant selectors
 * (`.landing-reveal.is-visible …` in globals.css) can drive the chance
 * bars and the settlement checkmark without any extra JS.
 */
function StepCard({ index, title, description, children }: StepCardProps) {
  const [ref, visible] = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`landing-reveal ${visible ? "is-visible" : ""}`}
      style={{ transitionDelay: `${index * 100}ms` }}
    >
      <Card className="h-full p-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo/15 text-sm font-semibold text-indigo">
          {index + 1}
        </div>
        <h3 className="mt-4 text-lg font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-text-muted">{description}</p>
        <div className="mt-6">{children}</div>
      </Card>
    </div>
  );
}

/** Three strike rows with a Chance bar each; the bars fill on reveal via CSS only. */
function MiniLadder() {
  return (
    <div className="space-y-3">
      {LADDER_ROWS.map((row) => (
        <div key={row.strike} className="flex items-center gap-3">
          <span className="num w-14 text-sm text-text-muted">
            {row.strike}
            {row.atMoney ? <span className="ml-1 text-[10px] text-indigo">Near price</span> : null}
          </span>
          <div
            className="landing-chance-bar flex-1"
            style={{ "--chance": `${row.chance}%` } as CSSProperties}
          >
            <div className="landing-chance-bar-fill" />
          </div>
          <span className="num w-10 text-right text-xs text-text-muted">{row.chance}%</span>
        </div>
      ))}
    </div>
  );
}

/** The payoff example with a big price counting up from $0.00 to $0.65 on its own reveal. */
function PayoffDemo() {
  const [ref, visible] = useReveal<HTMLDivElement>();
  const counted = useCountUp(EXAMPLE_YES_PRICE_MICRO, 900, visible);
  return (
    <div ref={ref}>
      <div className="num text-3xl font-semibold text-cyan">{formatUsd(counted)}</div>
      <div className="mt-3 text-sm text-text-muted">
        <PayoffLine ticker="META" strike={EXAMPLE_STRIKE_MICRO} cost={EXAMPLE_YES_PRICE_MICRO} />
      </div>
    </div>
  );
}

/** Clock face with a checkmark that draws in on reveal (CSS transition, driven by the ancestor's `is-visible` class). */
function SettlementClock() {
  return (
    <svg viewBox="0 0 100 100" className="h-16 w-16" role="img" aria-label="Settlement check">
      <circle cx="50" cy="50" r="34" fill="none" stroke="var(--color-indigo)" strokeWidth="4" />
      <line x1="50" y1="50" x2="50" y2="28" stroke="var(--color-indigo)" strokeWidth="4" strokeLinecap="round" />
      <line x1="50" y1="50" x2="66" y2="58" stroke="var(--color-indigo)" strokeWidth="4" strokeLinecap="round" />
      <path
        d="M30 52 L45 66 L74 34"
        fill="none"
        stroke="var(--color-success)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="landing-check-path"
      />
    </svg>
  );
}

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="text-center text-2xl font-semibold sm:text-3xl">How it works</h2>
      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        <StepCard
          index={0}
          title="Pick a stock and a price to beat"
          description="Every market has a ticker and a strike price it needs to close above."
        >
          <MiniLadder />
        </StepCard>
        <StepCard
          index={1}
          title="Buy Yes or No for less than $1"
          description="Each contract costs less than a dollar and is worth exactly $1.00 if you're right."
        >
          <PayoffDemo />
        </StepCard>
        <StepCard
          index={2}
          title="Settled at the 4:00 PM close, paid in USDC"
          description="Markets settle on the official closing price and pay out straight to your wallet."
        >
          <SettlementClock />
        </StepCard>
      </div>
    </section>
  );
}
