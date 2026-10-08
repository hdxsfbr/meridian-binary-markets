"use client";

import { useEffect, useState } from "react";
import { countdownLabel, formatUsd } from "@/lib/format";

export type CountdownProps = {
  /** Market close time, as a Unix timestamp in seconds (16:00 ET for the trading day). */
  closeTs: number;
  /** Whether the market has a recorded settlement outcome. */
  settled?: boolean;
  /** Settlement price (micro-USD), shown once `settled` is true. */
  settlementPriceMicro?: bigint;
};

const WARNING_THRESHOLD_SECONDS = 30 * 60;

export function Countdown({ closeTs, settled, settlementPriceMicro }: CountdownProps) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  if (settled) {
    const label = settlementPriceMicro !== undefined ? `Settled at ${formatUsd(settlementPriceMicro)}` : "Settled";
    return (
      <span className="num rounded-full border border-border bg-surface-raised px-3 py-1 text-sm text-text-muted">{label}</span>
    );
  }

  if (now === null) {
    return null;
  }

  const label = countdownLabel(now, closeTs, settled);
  if (label === null) {
    return null;
  }

  const isPastClose = label === "Settlement pending";
  const remaining = closeTs - now;
  const isWarning = !isPastClose && remaining <= WARNING_THRESHOLD_SECONDS;
  const display = isPastClose ? "Closed, settling…" : label;

  const toneClass = isPastClose || isWarning ? "border-warning/60 bg-warning/10 text-warning" : "border-border bg-surface-raised text-text-muted";

  return <span className={`num rounded-full border px-3 py-1 text-sm ${toneClass}`}>{display}</span>;
}
