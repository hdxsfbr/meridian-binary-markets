"use client";

import { useEffect, useState } from "react";
import { countdownLabel } from "@/lib/format";

export type CountdownProps = {
  /** Market close time, as a Unix timestamp in seconds (16:00 ET for the trading day). */
  closeTs: number;
  /** Whether the market has a recorded settlement outcome. */
  settled?: boolean;
};

export function Countdown({ closeTs, settled }: CountdownProps) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  if (now === null) {
    return null;
  }

  const label = countdownLabel(now, closeTs, settled);
  if (label === null) {
    return null;
  }

  return <span>{label}</span>;
}
