import { formatUsd } from "@/lib/format";
import type { HistoryEntry } from "@/hooks/useHistory";
import { TickerMark } from "@/components/TickerMark";

export type HistoryRowProps = {
  entry: HistoryEntry;
};

function formatTime(ts: number | undefined): string {
  if (ts === undefined) {
    return "";
  }
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** One line of the wallet's execution log: what happened, the amount (if any), when, and a link to the explorer. */
export function HistoryRow({ entry }: HistoryRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 truncate">
          {entry.ticker !== undefined ? <TickerMark ticker={entry.ticker} size={20} /> : null}
          <span className="truncate">
            {entry.label}
            {entry.market !== undefined ? <span className="ml-2 text-text-muted">· {entry.market}</span> : null}
          </span>
        </span>
        <span className="text-sm text-text-muted">{formatTime(entry.ts)}</span>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {entry.amountMicro !== undefined ? <span className="num text-right">{formatUsd(entry.amountMicro)}</span> : null}
        {entry.yesQty !== undefined ? <span className="num text-right">{entry.yesQty.toString()} Yes</span> : null}
        <a
          href={entry.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-text-muted"
        >
          View
        </a>
      </div>
    </div>
  );
}
