import { formatUsd } from "@/lib/format";
import type { HistoryEntry } from "@/hooks/useHistory";

export type HistoryRowProps = {
  entry: HistoryEntry;
};

function formatTimestamp(ts: number | undefined): string {
  if (ts === undefined) {
    return "";
  }
  return new Date(ts * 1000).toLocaleString();
}

/** One line of the wallet's execution log: what happened, the amount (if any), when, and a link to the explorer. */
export function HistoryRow({ entry }: HistoryRowProps) {
  return (
    <div className="flex items-center justify-between border-b border-black/10 py-2">
      <div className="flex flex-col">
        <span>
          {entry.label}
          {entry.market !== undefined ? <span className="ml-2 text-black/60">{entry.market}</span> : null}
        </span>
        <span className="text-sm text-black/60">{formatTimestamp(entry.ts)}</span>
      </div>
      <div className="flex items-center gap-4">
        {entry.amountMicro !== undefined ? <span>{formatUsd(entry.amountMicro)}</span> : null}
        {entry.yesQty !== undefined ? <span>{entry.yesQty.toString()} Yes</span> : null}
        <a href={entry.explorerUrl} target="_blank" rel="noreferrer" className="underline">
          View
        </a>
      </div>
    </div>
  );
}
