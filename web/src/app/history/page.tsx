"use client";

/**
 * T079: History page -- the wallet's chronological execution log (mints,
 * fills, cancels, settlements, redemptions), newest first, each linking to
 * the explorer (contracts/frontend.md `/history` row; research.md R11).
 */

import { useWallet } from "@solana/wallet-adapter-react";
import { useHistory } from "@/hooks/useHistory";
import { HistoryRow } from "@/components/HistoryRow";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineError } from "@/components/ui/InlineError";

export default function HistoryPage() {
  const { publicKey } = useWallet();
  const { entries, loading, error } = useHistory(publicKey ?? null);

  if (!publicKey) {
    return (
      <div className="mx-auto max-w-[1440px] px-6 py-4">
        <h1 className="text-2xl font-semibold">History</h1>
        <p className="mt-4 text-text-muted">Connect a wallet to see your history.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-4">
      <h1 className="text-2xl font-semibold">History</h1>
      {loading ? (
        <div className="mt-4 flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}
      {!loading && error ? (
        <div className="mt-4">
          <InlineError>Could not load your history. Retrying…</InlineError>
        </div>
      ) : null}
      {!loading && !error && entries.length === 0 ? (
        <div className="mt-4">
          <EmptyState>No activity yet.</EmptyState>
        </div>
      ) : null}
      <div className="mt-4 flex flex-col">
        {entries.map((entry, i) => (
          <HistoryRow key={`${entry.signature}:${i}`} entry={entry} />
        ))}
      </div>
    </div>
  );
}
