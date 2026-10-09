"use client";

/**
 * Trade page's session price chart (REVAMP_PLAN.md Wave R3, decision 2;
 * replaces the hand-written SVG sparkline with TradingView Lightweight
 * Charts). Data comes from `usePriceHistory` (a client-side ring buffer
 * sampled from the already-polled price feed and seeded once per session
 * from the server's intraday backfill) -- this component itself makes no
 * network call; the `loading` prop just reflects whether that hook's seed
 * fetch is still in flight, for the empty-state copy below.
 *
 * The charting library touches `window`/canvas at module load, so it's
 * imported dynamically inside an effect rather than at module scope --
 * this keeps the production build free of any top-level `window`
 * reference and lets this file be imported safely during server
 * rendering. Callers should additionally load this component itself via
 * `next/dynamic` with `ssr: false`.
 */

import { useEffect, useRef, useState } from "react";
import type { AutoscaleInfoProvider, IChartApi, ISeriesApi, IPriceLine, UTCTimestamp } from "lightweight-charts";
import { formatUsd } from "@/lib/format";
import type { PricePoint } from "@/lib/price-history";

export type PriceChartProps = {
  ticker: string;
  points: readonly PricePoint[];
  strikeMicro?: bigint;
  /** True while the session backfill fetch is in flight and `points` doesn't have enough samples to draw yet. */
  loading?: boolean;
};

const DESKTOP_HEIGHT = 220;
const MOBILE_HEIGHT = 160;
const MOBILE_BREAKPOINT_PX = 640;

const ONE_USDC = 1_000_000;

function toPrice(priceMicro: bigint): number {
  return Number(priceMicro) / ONE_USDC;
}

type ThemeColors = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  cyan: string;
};

function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: read("--color-bg", "#0b1026"),
    surface: read("--color-surface", "#111b35"),
    border: read("--color-border", "#293654"),
    text: read("--color-text", "#f8fafc"),
    textMuted: read("--color-text-muted", "#a9b5c9"),
    cyan: read("--color-cyan", "#22d3ee"),
  };
}

export function PriceChart({ ticker, points, strikeMicro, loading = false }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const strikeLineRef = useRef<IPriceLine | null>(null);
  const [ready, setReady] = useState(false);

  const hasPoints = points.length >= 2;

  // Chart lifecycle: create once the container exists and there are
  // enough points to draw, tear down on unmount or once points drop below
  // the threshold (e.g. a ticker switch resets the buffer).
  useEffect(() => {
    if (!hasPoints) {
      return;
    }
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let mediaQuery: MediaQueryList | null = null;
    let themeObserver: MutationObserver | null = null;

    async function setup() {
      const { createChart, AreaSeries, LineStyle, ColorType } = await import("lightweight-charts");
      if (disposed || container === null) {
        return;
      }

      const colors = readThemeColors();
      const heightFor = () =>
        window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`).matches ? MOBILE_HEIGHT : DESKTOP_HEIGHT;

      const chart = createChart(container, {
        width: container.clientWidth,
        height: heightFor(),
        autoSize: false,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: colors.textMuted,
          fontFamily: "var(--font-mono)",
          attributionLogo: true,
        },
        grid: {
          vertLines: { color: colors.border },
          horzLines: { color: colors.border },
        },
        crosshair: {
          vertLine: { color: colors.textMuted, labelBackgroundColor: colors.surface },
          horzLine: { color: colors.textMuted, labelBackgroundColor: colors.surface },
        },
        rightPriceScale: {
          borderColor: colors.border,
        },
        timeScale: {
          borderColor: colors.border,
          timeVisible: true,
          secondsVisible: false,
        },
      });

      const series = chart.addSeries(AreaSeries, {
        lineColor: colors.cyan,
        topColor: `${colors.cyan}33`,
        bottomColor: `${colors.cyan}00`,
        lineWidth: 2,
        priceFormat: {
          type: "custom",
          formatter: (price: number) => formatUsd(BigInt(Math.round(price * ONE_USDC))),
          minMove: 0.01,
        },
      });

      series.setData(points.map((p) => ({ time: p.ts as unknown as UTCTimestamp, value: toPrice(p.priceMicro) })));

      if (strikeMicro !== undefined) {
        const strikePrice = toPrice(strikeMicro);
        const autoscaleInfoProvider: AutoscaleInfoProvider = (original) => {
          const base = original();
          if (base === null || base.priceRange === null) {
            return base;
          }
          return {
            priceRange: {
              minValue: Math.min(base.priceRange.minValue, strikePrice),
              maxValue: Math.max(base.priceRange.maxValue, strikePrice),
            },
            margins: base.margins,
          };
        };
        series.applyOptions({ autoscaleInfoProvider });
        strikeLineRef.current = series.createPriceLine({
          price: strikePrice,
          color: colors.textMuted,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `Strike ${formatUsd(strikeMicro)}`,
        });
      }

      chart.timeScale().fitContent();

      chartRef.current = chart;
      seriesRef.current = series;
      setReady(true);

      resizeObserver = new ResizeObserver(() => {
        if (container.clientWidth > 0) {
          chart.applyOptions({ width: container.clientWidth, height: heightFor() });
        }
      });
      resizeObserver.observe(container);

      mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
      const onBreakpointChange = () => chart.applyOptions({ height: heightFor() });
      mediaQuery.addEventListener("change", onBreakpointChange);

      // Re-reads theme tokens on `data-theme` flips so the chart matches a
      // runtime theme toggle; cheap since it's a single attribute watch.
      themeObserver = new MutationObserver(() => {
        const next = readThemeColors();
        chart.applyOptions({
          layout: { textColor: next.textMuted },
          grid: { vertLines: { color: next.border }, horzLines: { color: next.border } },
          crosshair: {
            vertLine: { color: next.textMuted, labelBackgroundColor: next.surface },
            horzLine: { color: next.textMuted, labelBackgroundColor: next.surface },
          },
          rightPriceScale: { borderColor: next.border },
          timeScale: { borderColor: next.border },
        });
        series.applyOptions({ lineColor: next.cyan, topColor: `${next.cyan}33`, bottomColor: `${next.cyan}00` });
        if (strikeLineRef.current !== null) {
          strikeLineRef.current.applyOptions({ color: next.textMuted });
        }
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      return () => {
        mediaQuery?.removeEventListener("change", onBreakpointChange);
      };
    }

    let cleanupMedia: (() => void) | undefined;
    void setup().then((fn) => {
      cleanupMedia = fn;
    });

    return () => {
      disposed = true;
      cleanupMedia?.();
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      strikeLineRef.current = null;
      setReady(false);
    };
    // Points update in place via the ring buffer; re-running this whole
    // effect per tick would thrash the chart, so live updates are pushed
    // through the separate effect below instead. This effect only
    // (re)creates the chart when the ticker/strike identity changes or
    // when going from <2 points to >=2 (first paint).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, strikeMicro, hasPoints]);

  // Pushes new/updated points into the already-created series without
  // tearing the chart down, so live 15s samples animate in smoothly.
  useEffect(() => {
    const series = seriesRef.current;
    if (series === null || !ready || points.length === 0) {
      return;
    }
    series.setData(
      points.map((p) => ({ time: p.ts as unknown as UTCTimestamp, value: toPrice(p.priceMicro) })),
    );
  }, [points, ready]);

  const last = points[points.length - 1];
  const summary =
    last !== undefined
      ? `${ticker} ${formatUsd(last.priceMicro)}${
          strikeMicro !== undefined ? `, strike ${formatUsd(strikeMicro)}` : ""
        }, ${points.length} samples`
      : `${ticker} price history`;

  if (!hasPoints) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-border bg-surface text-sm text-text-muted"
        style={{ height: DESKTOP_HEIGHT }}
      >
        {loading ? "Loading price history…" : "No price history yet"}
        <span className="sr-only">{summary}</span>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div
        ref={containerRef}
        role="img"
        aria-label={summary}
        className="w-full overflow-hidden rounded-md border border-border bg-surface"
      />
      <span className="sr-only">{summary}</span>
    </div>
  );
}
