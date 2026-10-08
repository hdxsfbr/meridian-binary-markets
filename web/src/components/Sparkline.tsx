"use client";

/**
 * Small session sparkline of the live price under the Trade page's header
 * (REVAMP_PLAN.md Wave R3, decision 2), with the selected strike as a
 * dotted horizontal line. Data comes from `usePriceHistory` (a client-side
 * ring buffer sampled from the already-polled price feed, persisted to
 * `sessionStorage`) -- this component itself makes no network call.
 */

import { useRef, useState } from "react";
import { formatUsd } from "@/lib/format";
import type { PricePoint } from "@/lib/price-history";

export type SparklineProps = {
  ticker: string;
  points: readonly PricePoint[];
  strikeMicro?: bigint;
  height?: number;
};

const VIEWBOX_WIDTH = 600;

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function Sparkline({ ticker, points, strikeMicro, height = 96 }: SparklineProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-border bg-surface text-sm text-text-muted"
        style={{ height }}
      >
        Collecting price history…
      </div>
    );
  }

  const last = points[points.length - 1];
  const prices = points.map((p) => p.priceMicro);
  const allValues = strikeMicro !== undefined ? [...prices, strikeMicro] : prices;
  const min = allValues.reduce((a, b) => (b < a ? b : a));
  const max = allValues.reduce((a, b) => (b > a ? b : a));
  const range = max - min;

  // Points are positioned by timestamp, not by array index, so the earliest
  // and latest sample always map to the chart's left/right edges even when
  // samples arrive at uneven intervals (e.g. a flat-price run that still
  // keeps a point per tick, per `price-history.ts`'s ts-based retention).
  const firstTs = points[0].ts;
  const lastTs = last.ts;
  const tsRange = lastTs - firstTs;

  function xFor(index: number): number {
    if (tsRange <= 0) {
      return points.length === 1 ? 0 : (index / (points.length - 1)) * VIEWBOX_WIDTH;
    }
    return ((points[index].ts - firstTs) / tsRange) * VIEWBOX_WIDTH;
  }
  function yFor(priceMicro: bigint): number {
    if (range === 0n) {
      return height / 2;
    }
    const fraction = Number(((priceMicro - min) * 10_000n) / range) / 10_000;
    return height - fraction * height;
  }

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(p.priceMicro).toFixed(1)}`).join(" ");
  const strikeY = strikeMicro !== undefined ? yFor(strikeMicro) : undefined;

  const summary = `${ticker} ${formatUsd(last.priceMicro)}${
    strikeMicro !== undefined ? `, strike ${formatUsd(strikeMicro)}` : ""
  }, ${points.length} samples`;

  // Hover readout: nearest sample to the pointer's x position.
  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (svg === null) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * VIEWBOX_WIDTH;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const d = Math.abs(xFor(i) - x);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    setHoverIndex(best);
  }
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const shown = hovered ?? last;

  return (
    <div className="w-full">
      <div className="num mb-1 flex items-baseline justify-between text-xs">
        <span className="text-text">
          {formatUsd(shown.priceMicro)}
          <span className="ml-2 text-text-muted">{hovered !== null ? formatTime(hovered.ts) : "now"}</span>
        </span>
        {strikeMicro !== undefined ? <span className="text-text-muted">Strike {formatUsd(strikeMicro)}</span> : null}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`}
        preserveAspectRatio="none"
        className="w-full cursor-crosshair"
        style={{ height }}
        role="img"
        aria-label={summary}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        {strikeY !== undefined ? (
          <line
            x1={0}
            y1={strikeY}
            x2={VIEWBOX_WIDTH}
            y2={strikeY}
            stroke="var(--color-text-muted)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        ) : null}
        <path d={path} fill="none" stroke="var(--color-cyan)" strokeWidth={2} />
        {hoverIndex !== null ? (
          <g>
            <line
              x1={xFor(hoverIndex)}
              y1={0}
              x2={xFor(hoverIndex)}
              y2={height}
              stroke="var(--color-text-muted)"
              strokeWidth={1}
            />
            <circle cx={xFor(hoverIndex)} cy={yFor(points[hoverIndex].priceMicro)} r={4} fill="var(--color-cyan)" />
          </g>
        ) : null}
      </svg>
      <div className="num mt-1 flex justify-between text-xs text-text-muted">
        <span>{formatUsd(min)}</span>
        <span>{formatUsd(max)}</span>
      </div>
      <span className="sr-only">{summary}</span>
    </div>
  );
}
