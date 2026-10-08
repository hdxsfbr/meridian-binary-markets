"use client";

/**
 * `/trade` has no ticker of its own: send the visitor to the first ticker
 * with contracts today, or to Markets when there are none yet.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMarkets } from "@/hooks/useMarkets";
import { Skeleton } from "@/components/ui/Skeleton";

export default function TradeIndexPage() {
  const router = useRouter();
  const { markets, loading } = useMarkets();

  useEffect(() => {
    if (loading) return;
    const first = [...markets].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0))[0];
    router.replace(first ? `/trade/${first.ticker}` : "/markets");
  }, [loading, markets, router]);

  return (
    <div className="px-6 py-8">
      <Skeleton className="h-6 w-48" />
    </div>
  );
}
