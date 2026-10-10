"use client";

/**
 * A `formatUsd` price that, on a `valueMicro` change, rolls only the
 * digits that actually changed (odometer-style, ~350ms, `.animated-price-roll`
 * in globals.css) and tints the whole number `--color-yes`/`--color-no`
 * for an increase/decrease before fading back to its inherited colour
 * (~900ms, `.animated-price-flash-up`/`-down`). The animating is all CSS
 * keyframes; React's only job is computing the character diff and the
 * tint direction on each change (`diffPriceChars`) and remounting the
 * (small) animated subtree via a `key` so the keyframes restart cleanly --
 * no per-frame JS, no animation library. `prefers-reduced-motion` needs no
 * special-casing here: the global rule in globals.css already collapses
 * every animation/transition duration on the page to near-zero, which
 * turns both the roll and the tint into a plain instant swap.
 *
 * Used for: the Trade page header price, the Nav ticker tape (both
 * marquee copies), and the landing hero chart's live-price readout.
 */

import { useRef, useState } from "react";
import { formatUsd } from "@/lib/format";

/** One character of a formatted price string: whether it changed from the previous formatted string, and (if so) the glyph it's rolling in from. */
export type PriceCharDiff = { char: string; changed: boolean; prevChar?: string };

/**
 * Character-by-character diff between two already-`formatUsd`-formatted
 * price strings (e.g. `"$83000.92"` vs `"$83000.47"`), used to decide
 * which glyphs `AnimatedPrice` rolls and which stay static so the layout
 * never shifts. Equal length: a straight per-index compare. Different
 * length (e.g. `"$999.99"` -> `"$1000.00"`, a new leading digit): there is
 * no stable index alignment across the two strings -- the digit grid
 * itself changed -- so every character is reported changed (with no
 * `prevChar`) rather than guessing at a partial alignment that could
 * misattribute which digit actually moved.
 */
export function diffPriceChars(prev: string, next: string): PriceCharDiff[] {
  if (prev === next) {
    return next.split("").map((char) => ({ char, changed: false }));
  }
  if (prev.length !== next.length) {
    return next.split("").map((char) => ({ char, changed: true }));
  }
  return next.split("").map((char, i) => (prev[i] === char ? { char, changed: false } : { char, changed: true, prevChar: prev[i] }));
}

export type AnimatedPriceProps = {
  /** Micro-USD/USDC, same unit `formatUsd` takes. */
  valueMicro: bigint;
  className?: string;
};

type FlashState = { generation: number; diff: PriceCharDiff[]; direction: "up" | "down" | null };

export function AnimatedPrice({ valueMicro, className }: AnimatedPriceProps) {
  const formatted = formatUsd(valueMicro);
  const prevValueRef = useRef(valueMicro);
  const prevFormattedRef = useRef(formatted);
  const [state, setState] = useState<FlashState>(() => ({
    generation: 0,
    diff: diffPriceChars(formatted, formatted),
    direction: null,
  }));

  // Adjusting state during render in response to a prop change (rather
  // than in an effect) is the React-documented pattern for derived state:
  // it lets the very same commit paint the new diff/tint instead of
  // lagging a frame behind the price that triggered it. The `!==` guard
  // against `prevValueRef.current` makes this terminate after one retry.
  if (valueMicro !== prevValueRef.current) {
    const prevValue = prevValueRef.current;
    const prevFormatted = prevFormattedRef.current;
    prevValueRef.current = valueMicro;
    prevFormattedRef.current = formatted;
    setState((s) => ({
      generation: s.generation + 1,
      diff: diffPriceChars(prevFormatted, formatted),
      direction: valueMicro > prevValue ? "up" : "down",
    }));
  }

  const flashClass =
    state.direction === "up" ? "animated-price-flash-up" : state.direction === "down" ? "animated-price-flash-down" : "";

  return (
    <span key={state.generation} className={["animated-price", "num", flashClass, className].filter(Boolean).join(" ")}>
      <span aria-hidden="true">
        {state.diff.map((d, i) =>
          d.changed && d.prevChar !== undefined ? (
            <span key={i} className="animated-price-roll">
              <span className="animated-price-roll-inner">
                <span className="animated-price-roll-glyph">{d.prevChar}</span>
                <span className="animated-price-roll-glyph">{d.char}</span>
              </span>
            </span>
          ) : (
            <span key={i}>{d.char}</span>
          ),
        )}
      </span>
      <span className="sr-only" aria-live="off">
        {formatted}
      </span>
    </span>
  );
}
