import { formatCloseTimeEt } from "@/lib/markets";
import { Card } from "./ui/Card";

export type SettlementSummaryProps = {
  /** Count of markets settled today, across every ticker. */
  count: number;
  /** Any one of today's markets' `closeTs` (Unix seconds); they share the same close time. */
  closeTs: number;
};

/** The Markets page's featured slot once nothing is open: today's settlement summary, no mock data. */
export function SettlementSummary({ count, closeTs }: SettlementSummaryProps) {
  return (
    <Card className="p-5">
      <p className="text-sm text-text-muted">Today’s markets</p>
      <p className="num mt-1 text-xl font-semibold">
        All {count} closed at {formatCloseTimeEt(closeTs)}
      </p>
    </Card>
  );
}
