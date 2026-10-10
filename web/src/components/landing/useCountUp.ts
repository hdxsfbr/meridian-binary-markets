"use client";

import { useEffect, useState } from "react";

/**
 * Animates a micro-USD amount from $0.00 up to `targetMicro` over
 * `durationMs`, starting once `start` becomes true (driven by
 * `useReveal`). Snaps straight to the target under
 * `prefers-reduced-motion: reduce` rather than counting, since that
 * preference is read in JS here (the CSS media rule in globals.css can't
 * reach a `requestAnimationFrame` loop).
 */
export function useCountUp(targetMicro: bigint, durationMs: number, start: boolean): bigint {
  const [value, setValue] = useState(0n);

  useEffect(() => {
    if (!start) return;

    const reduceMotion =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setValue(targetMicro);
      return;
    }

    const target = Number(targetMicro);
    const startTime = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startTime) / durationMs);
      setValue(BigInt(Math.round(target * progress)));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [start, targetMicro, durationMs]);

  return value;
}
