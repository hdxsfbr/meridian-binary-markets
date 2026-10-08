"use client";

import { useEffect, useState } from "react";

/** The current time, Unix seconds, ticking every `intervalMs` (1s by default); one shared clock for a page's countdown chips so each card doesn't run its own interval. */
export function useNowSeconds(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
