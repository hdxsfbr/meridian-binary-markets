"use client";

/**
 * The hero's real intraday chart (replaces the synthetic `LiveChart` SVG
 * loop): a TradingView Lightweight Charts area series of the session for
 * whichever ticker `LandingHero` is currently cycling through, same
 * library/pattern as the Trade page's `PriceChart` (colours from CSS
 * variables, dynamic import so no top-level `window` reference, a
 * ResizeObserver for the responsive height, a dashed strike line, and
 * autoscale widened to include the strike).
 *
 * Three render states:
 *  - `seeding` with no points yet: a `Skeleton` shimmer filling the
 *    reserved box, so the hero never collapses while `/api/price-history`
 *    is in flight.
 *  - seeding finished but still fewer than two points (e.g. a weekend,
 *    before any session data exists): falls back to the old synthetic
 *    `LiveChart` so the hero never looks broken.
 *  - otherwise: the real chart, a pulsing dot over the latest sample
 *    (positioned from `series.priceToCoordinate`/`timeScale.timeToCoordinate`,
 *    not CSS, since those are the only accurate chart-space coordinates),
 *    and a Yes/No badge comparing the latest price to the strike.
 *
 * Ticker-change transition: a `phase` state machine fades the chart
 * container to 0 over 150ms, then (after the chart below has rebuilt
 * itself for the new ticker/strike) reveals it left-to-right over ~900ms
 * via a `clip-path: inset()` animation (`hero-chart-reveal` in
 * globals.css). `prefers-reduced-motion` skips the whole machine -- the
 * global rule in globals.css already collapses the CSS animation itself,
 * but the JS-driven phase changes need their own check so the swap is
 * instant rather than merely fast.
 */

import { useEffect, useRef, useState } from "react";
import type { AutoscaleInfoProvider, IChartApi, ISeriesApi, IPriceLine, UTCTimestamp } from "lightweight-charts";
import type { Ticker } from "@meridian/sdk";
import { formatStrike, formatUsd } from "@/lib/format";
import type { PricePoint } from "@/lib/price-history";
import { usePriceHistory } from "@/hooks/usePriceHistory";
import { Skeleton } from "@/components/ui/Skeleton";
import { LiveChart } from "./LiveChart";

export type HeroChartProps = {
  ticker: Ticker;
  strikeMicro: bigint;
};

const DESKTOP_HEIGHT = 360;
const MOBILE_HEIGHT = 240;
const MOBILE_BREAKPOINT_PX = 640;
const ONE_USDC = 1_000_000;
const FADE_OUT_MS = 150;
const REVEAL_MS = 900;

function toPrice(priceMicro: bigint): number {
  return Number(priceMicro) / ONE_USDC;
}

type ThemeColors = {
  surface: string;
  border: string;
  textMuted: string;
  cyan: string;
};

function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    surface: read("--color-surface", "#111b35"),
    border: read("--color-border", "#293654"),
    textMuted: read("--color-text-muted", "#a9b5c9"),
    cyan: read("--color-cyan", "#22d3ee"),
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Pixel coordinates (relative to the chart container) of `point`, or `null` while the chart hasn't laid out yet. */
function dotCoordinates(
  chart: IChartApi,
  series: ISeriesApi<"Area">,
  point: PricePoint,
): { x: number; y: number } | null {
  const x = chart.timeScale().timeToCoordinate(point.ts as unknown as UTCTimestamp);
  const y = series.priceToCoordinate(toPrice(point.priceMicro));
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
}

export function HeroChart({ ticker, strikeMicro }: HeroChartProps) {
  const { points, seeding } = usePriceHistory(ticker);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const strikeLineRef = useRef<IPriceLine | null>(null);
  const [ready, setReady] = useState(false);
  const [dotPos, setDotPos] = useState<{ x: number; y: number } | null>(null);
  const [phase, setPhase] = useState<"idle" | "fading" | "revealing">("idle");
  const prevTickerRef = useRef(ticker);

  const hasPoints = points.length >= 2;
  const showSkeleton = seeding && points.length === 0;
  const showFallback = !seeding && !hasPoints;

  // Always-current points, read by the ResizeObserver callback below
  // (which otherwise closes over the chart-creation effect's `points` at
  // setup time rather than the latest live samples).
  const pointsRef = useRef(points);
  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  // Ticker-change transition: fade out, then (once the rebuild effect
  // below has swapped the chart's data for the new ticker) reveal
  // left-to-right. Reduced motion skips straight to the end state.
  useEffect(() => {
    if (prevTickerRef.current === ticker) {
      return;
    }
    prevTickerRef.current = ticker;
    if (prefersReducedMotion()) {
      setPhase("idle");
      return;
    }
    setPhase("fading");
    const revealTimer = setTimeout(() => setPhase("revealing"), FADE_OUT_MS);
    const idleTimer = setTimeout(() => setPhase("idle"), FADE_OUT_MS + REVEAL_MS);
    return () => {
      clearTimeout(revealTimer);
      clearTimeout(idleTimer);
    };
  }, [ticker]);

  // Chart lifecycle: (re)create once the container exists and there are
  // enough points to draw. Mirrors PriceChart.tsx's two-effect split --
  // this effect only (re)creates the chart on ticker/strike change (or
  // first paint); live ticks are pushed through the effect below instead.
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
      // Size to the padded container so the time axis is never clipped; the
      // constants only serve as a fallback before layout has run.
      const heightFor = () =>
        container.clientHeight > 0
          ? container.clientHeight
          : window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`).matches
            ? MOBILE_HEIGHT
            : DESKTOP_HEIGHT;

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
          vertLines: { visible: false },
          horzLines: { visible: false },
        },
        crosshair: {
          vertLine: { visible: false, labelVisible: false },
          horzLine: { visible: false, labelVisible: false },
        },
        rightPriceScale: {
          borderColor: colors.border,
          borderVisible: true,
        },
        timeScale: {
          borderColor: colors.border,
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time: UTCTimestamp) =>
            new Date(time * 1000).toLocaleTimeString([], { hour: "numeric" }),
        },
      });

      const series = chart.addSeries(AreaSeries, {
        lineColor: colors.cyan,
        topColor: `${colors.cyan}59`,
        bottomColor: `${colors.cyan}00`,
        lineWidth: 2,
        priceFormat: {
          type: "custom",
          formatter: (price: number) => formatUsd(BigInt(Math.round(price * ONE_USDC))),
          minMove: 0.01,
        },
      });

      series.setData(points.map((p) => ({ time: p.ts as unknown as UTCTimestamp, value: toPrice(p.priceMicro) })));

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
        axisLabelVisible: false,
        title: formatUsd(strikeMicro),
      });

      chart.timeScale().fitContent();

      chartRef.current = chart;
      seriesRef.current = series;
      setReady(true);

      const lastPoint = points[points.length - 1];
      if (lastPoint !== undefined) {
        requestAnimationFrame(() => {
          if (disposed) {
            return;
          }
          setDotPos(dotCoordinates(chart, series, lastPoint));
        });
      }

      resizeObserver = new ResizeObserver(() => {
        if (container.clientWidth === 0) {
          return;
        }
        chart.applyOptions({ width: container.clientWidth, height: heightFor() });
        const current = pointsRef.current[pointsRef.current.length - 1];
        if (current !== undefined) {
          requestAnimationFrame(() => {
            if (disposed) {
              return;
            }
            setDotPos(dotCoordinates(chart, series, current));
          });
        }
      });
      resizeObserver.observe(container);

      mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
      const onBreakpointChange = () => chart.applyOptions({ height: heightFor() });
      mediaQuery.addEventListener("change", onBreakpointChange);

      // Re-reads theme tokens on `data-theme` flips, same as PriceChart.tsx.
      themeObserver = new MutationObserver(() => {
        const next = readThemeColors();
        chart.applyOptions({
          layout: { textColor: next.textMuted },
          crosshair: {
            vertLine: { color: next.textMuted, labelBackgroundColor: next.surface },
            horzLine: { color: next.textMuted, labelBackgroundColor: next.surface },
          },
          rightPriceScale: { borderColor: next.border },
          timeScale: { borderColor: next.border },
        });
        series.applyOptions({ lineColor: next.cyan, topColor: `${next.cyan}59`, bottomColor: `${next.cyan}00` });
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
      setDotPos(null);
    };
    // Points update in place via the ring buffer; re-running this whole
    // effect per tick would thrash the chart (and retrigger the ticker
    // transition), so live updates are pushed through the effect below
    // instead. This effect only (re)creates the chart when the
    // ticker/strike identity changes or when going from <2 points to >=2.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, strikeMicro, hasPoints]);

  // Pushes new/updated points into the already-created series without
  // tearing the chart down, and repositions the pulsing dot to match.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (chart === null || series === null || !ready || points.length === 0) {
      return;
    }
    series.setData(points.map((p) => ({ time: p.ts as unknown as UTCTimestamp, value: toPrice(p.priceMicro) })));
    const last = points[points.length - 1];
    if (last !== undefined) {
      requestAnimationFrame(() => {
        setDotPos(dotCoordinates(chart, series, last));
      });
    }
  }, [points, ready]);

  if (showSkeleton) {
    return (
      <div
        className="relative h-[240px] w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface/60 p-4 sm:h-[360px]"
        aria-hidden="true"
      >
        <Skeleton className="h-full w-full rounded-lg" />
      </div>
    );
  }

  if (showFallback) {
    return <LiveChart />;
  }

  const last = points[points.length - 1];
  const isYes = last !== undefined && last.priceMicro >= strikeMicro;
  const summary =
    last !== undefined
      ? `${ticker} ${formatUsd(last.priceMicro)}, strike ${formatStrike(strikeMicro)}, ${
          isYes ? "trading above strike" : "trading below strike"
        }`
      : `${ticker} price history`;

  return (
    <div className="relative h-[240px] w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface/60 p-4 sm:h-[360px]">
      <div className="relative h-full w-full">
        <div
          ref={containerRef}
          data-phase={phase}
          className="hero-chart-container h-full w-full overflow-hidden rounded-lg"
          role="img"
          aria-label={summary}
        />
        {dotPos !== null ? (
          <div className="hero-chart-dot" style={{ left: dotPos.x, top: dotPos.y }} aria-hidden="true" />
        ) : null}
        <div
          className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md border border-border bg-surface/80 px-2 py-1 font-mono text-xs backdrop-blur-sm"
          aria-hidden="true"
        >
          <span
            className={
              isYes
                ? "hero-chart-badge-yes rounded-sm px-1 py-0.5 font-semibold text-yes"
                : "rounded-sm px-1 py-0.5 font-semibold text-no"
            }
          >
            {isYes ? "Yes" : "No"}
          </span>
          <span className="text-text-muted">
            {ticker} {last !== undefined ? formatUsd(last.priceMicro) : "—"} · Strike {formatStrike(strikeMicro)}
          </span>
        </div>
      </div>
      <span className="sr-only">{summary}</span>
    </div>
  );
}
