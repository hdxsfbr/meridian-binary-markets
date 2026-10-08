import { formatPrice, formatStrike, impliedProbability } from "@/lib/format";
import { PayoffLine } from "./PayoffLine";

export type Settlement = {
  price: bigint;
  outcome: "yes" | "no";
};

export type ContractCardProps = {
  ticker: string;
  strike: bigint;
  yesPrice: bigint;
  noPrice: bigint;
  closeTs: number;
  settled?: Settlement;
  /** Whether the connected wallet holds a winning position it can redeem. */
  canRedeem?: boolean;
  onRedeem?: () => void;
};

export function ContractCard({
  ticker,
  strike,
  yesPrice,
  noPrice,
  settled,
  canRedeem,
  onRedeem,
}: ContractCardProps) {
  return (
    <div className="rounded border border-border p-4">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">{ticker}</span>
        <span>{formatStrike(strike)}</span>
      </div>
      <div className="mt-2 flex gap-4">
        <span>Yes {formatPrice(yesPrice)}</span>
        <span>No {formatPrice(noPrice)}</span>
        <span>{impliedProbability(yesPrice)}</span>
      </div>
      <div className="mt-2">
        <PayoffLine ticker={ticker} strike={strike} cost={yesPrice} />
      </div>
      {settled ? (
        <div className="mt-2 flex items-center justify-between">
          <span>
            Settled at {formatPrice(settled.price)} — {settled.outcome === "yes" ? "Yes" : "No"} wins
          </span>
          {canRedeem === true && onRedeem ? (
            <button type="button" onClick={onRedeem}>
              Redeem
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
