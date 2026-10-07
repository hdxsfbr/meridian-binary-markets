"use client";

/**
 * T079: History page -- the wallet's chronological execution log (mints,
 * fills, cancels, settlements, redemptions), newest first, each linking to
 * the explorer (contracts/frontend.md `/history` row; research.md R11).
 */

import { useWallet } from "@solana/wallet-adapter-react";
import { useHistory } from "@/hooks/useHistory";
import { HistoryRow } from "@/components/HistoryRow";

export default function HistoryPage() {
  const { publicKey } = useWallet();
  const { entries, loading, error } = useHistory(publicKey ?? null);

  if (!publicKey) {
    return (
      <div className="px-6 py-4">
        <h1 className="text-2xl font-semibold">History</h1>
        <p className="mt-4">Connect a wallet to see your history.</p>
      </div>
    );
  }

  return (
    <div className="px-6 py-4">
      <h1 className="text-2xl font-semibold">History</h1>
      {loading ? <p className="mt-4">Loading…</p> : null}
      {!loading && error ? <p className="mt-4">Could not load your history. Retrying…</p> : null}
      {!loading && !error && entries.length === 0 ? <p className="mt-4">No activity yet.</p> : null}
      <div className="mt-4 flex flex-col">
        {entries.map((entry, i) => (
          <HistoryRow key={`${entry.signature}:${i}`} entry={entry} />
        ))}
      </div>
    </div>
  );
}
