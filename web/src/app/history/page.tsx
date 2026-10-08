"use client";

/**
 * T079: History page -- the wallet's chronological execution log (mints,
 * fills, cancels, settlements, redemptions), newest first, each linking to
 * the explorer (contracts/frontend.md `/history` row; research.md R11).
 * Grouped under day headings (local date) -- `HistoryRow` keeps the
 * per-entry content, this page only adds the day dividers.
 */

import { useWallet } from "@solana/wallet-adapter-react";
import { useHistory } from "@/hooks/useHistory";
import { HistoryRow } from "@/components/HistoryRow";
import type { HistoryEntry } from "@/hooks/useHistory";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineError } from "@/components/ui/InlineError";

/** Entries already come newest-first from `useHistory`; this groups consecutive entries that fall on the same local day under one heading, without re-sorting. */
function groupByDay(entries: readonly HistoryEntry[]): Array<{ label: string; entries: HistoryEntry[] }> {
  const groups: Array<{ label: string; entries: HistoryEntry[] }> = [];
  for (const entry of entries) {
    const label =
      entry.ts === undefined
        ? "Unknown date"
        : new Date(entry.ts * 1000).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      last.entries.push(entry);
    } else {
      groups.push({ label, entries: [entry] });
    }
  }
  return groups;
}

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

  const groups = groupByDay(entries);

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
      <div className="mt-4 flex flex-col gap-6 overflow-x-auto">
        {groups.map((group) => (
          <section key={group.label} className="flex flex-col">
            <h2 className="pb-2 text-sm font-semibold text-text-muted">{group.label}</h2>
            <div className="flex flex-col">
              {group.entries.map((entry, i) => (
                <HistoryRow key={`${entry.signature}:${i}`} entry={entry} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
