"use client";

/**
 * The trade panel (T064): four action buttons, market/limit toggle, qty and
 * price inputs, a live estimate per contracts/frontend.md's "Translation
 * layer", and the position-gating / paused / settlement-state rules from
 * "Trade panel rules" (FR-012…FR-016). Builds and sends exactly one
 * transaction per click via `@/lib/tx`'s builders.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSendTransaction } from "../lib/wallet-send";
import {
  type Action,
  type Book as SdkBook,
  type Intent,
  type IntentPosition,
  type Kind,
  MAX_FILLS,
  describeTransientState,
  plannedFills,
  toInstructionPlan,
} from "@meridian/sdk";
import type { ConfigSnapshot } from "@/hooks/useConfig";
import type { MarketAccount } from "@/hooks/useMarkets";
import { useBook } from "@/hooks/useBook";
import { usePosition } from "@/hooks/usePosition";
import { useProgram } from "@/hooks/useProgram";
import { EmptyState } from "@/components/ui/EmptyState";
import { fetchUsdcMint, mapSendError, planToInstruction, sendTx, type BuildCtx } from "@/lib/tx";
import {
  ACTION_LABEL,
  CHECKING_POSITION,
  CONNECT_WALLET,
  KIND_LABEL,
  MINTED_PAIR,
  NO_HELD_YES_RESTING,
  REDEEM_IN_PORTFOLIO,
  SENDING,
  SETTLEMENT_PENDING,
  TRADING_PAUSED,
  estimateLabel,
  guidanceCopy,
  settledOutcomeCopy,
  NO_YES_TO_SELL,
  NO_NO_TO_SELL,
  HOLDINGS_LABEL,
  lockedUntilFilledLabel,
  winIfRightLabel,
} from "@/lib/trade-copy";

/** Visual style per action: side colour for the primary buy, outlined for the matching sell (REVAMP_PLAN Wave R3). */
const ACTION_STYLE: Record<Action, string> = {
  buyYes: "border-yes bg-yes/15 text-yes hover:bg-yes/25",
  buyNo: "border-no bg-no/15 text-no hover:bg-no/25",
  sellYes: "border-yes/50 bg-transparent text-yes hover:bg-yes/10",
  sellNo: "border-no/50 bg-transparent text-no hover:bg-no/10",
};

const QTY_PRESETS = ["1", "5", "10"] as const;

// Sweep-the-whole-book worst prices for a market buy's matched-quantity
// preview, mirroring `intent.ts`'s own `PRICE_MAX`/`PRICE_MIN` defaults for
// an unset `Intent.price` (not exported, so duplicated here as a comment
// rather than an import -- these are the two ends of the program's valid
// price range, 1..999_999 micro-USDC).
const SWEEP_WORST_BID_PRICE = 999_999n;
const SWEEP_WORST_ASK_PRICE = 1n;

/**
 * The quantity a Buy Yes/Buy No would actually execute right now: the full
 * requested quantity for a limit order (it rests for the remainder rather
 * than failing), or the quantity the book can actually match for a market
 * order, walked best-first up to the planner's `MAX_FILLS` cap -- the same
 * walk `toInstructionPlan` performs internally, replayed here against the
 * panel's own book snapshot since the plan's `Estimate` doesn't expose the
 * matched quantity itself.
 */
function matchedBuyQty(action: "buyYes" | "buyNo", kind: Kind, qty: bigint, book: SdkBook): bigint {
  if (kind === "limit") {
    return qty;
  }
  const side = action === "buyYes" ? "bid" : "ask";
  const worstPrice = action === "buyYes" ? SWEEP_WORST_BID_PRICE : SWEEP_WORST_ASK_PRICE;
  const { fills } = plannedFills(book, side, worstPrice, qty, MAX_FILLS);
  return fills.reduce((sum, f) => sum + f.qty, 0n);
}

export type TradePanelProps = {
  market: MarketAccount;
  config: ConfigSnapshot | null;
};

const ACTIONS: Action[] = ["buyYes", "buyNo", "sellYes", "sellNo"];

/** Parses a non-negative integer contract quantity; `undefined` for anything else (incl. empty). */
function parseQty(input: string): bigint | undefined {
  if (!/^\d+$/.test(input)) {
    return undefined;
  }
  const value = BigInt(input);
  return value > 0n ? value : undefined;
}

/** Parses a dollar-decimal price (e.g. "0.65") to micro-USDC; `undefined` for anything unparseable. */
function parsePriceMicro(input: string): bigint | undefined {
  const trimmed = input.trim();
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") {
    return undefined;
  }
  const [wholeStr, fracStr = ""] = trimmed.split(".");
  const whole = wholeStr === "" ? 0n : BigInt(wholeStr);
  const frac = BigInt((fracStr + "000000").slice(0, 6) || "0");
  return whole * 1_000_000n + frac;
}

export function TradePanel({ market, config }: TradePanelProps) {
  const program = useProgram();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const sendTransaction = useSendTransaction();

  const book = useBook(market.pubkey);
  const position = usePosition(market.pubkey, publicKey ?? undefined);

  const [kind, setKind] = useState<Kind>("market");
  const [qtyInput, setQtyInput] = useState("1");
  const [priceInput, setPriceInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const qty = parseQty(qtyInput);
  const price = parsePriceMicro(priceInput);

  const sdkBook: SdkBook | null = useMemo(() => {
    if (book.header === null) {
      return null;
    }
    return { header: book.header, bids: book.bids, asks: book.asks };
  }, [book.header, book.bids, book.asks]);

  // `pairsHeld` doubles as `mintedPairs` here (intent.ts's gating-exempt
  // baseline): this wave has no mint-history event log to distinguish a
  // minted pair from one bought at an even Yes/No price on the open
  // market, and `toInstructionPlan`'s gating check only ever reads
  // `yes`/`no` anyway (see `usePosition.ts`'s doc comment).
  const intentPosition: IntentPosition = { yes: position.yes, no: position.no, mintedPairs: position.pairsHeld };

  const plans = useMemo(() => {
    const result: Partial<Record<Action, ReturnType<typeof toInstructionPlan>>> = {};
    if (qty === undefined || sdkBook === null || (kind === "limit" && price === undefined)) {
      return result;
    }
    for (const action of ACTIONS) {
      const intent: Intent = { action, kind, qty, price };
      result[action] = toInstructionPlan(intent, intentPosition, sdkBook);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty, price, kind, sdkBook, intentPosition.yes, intentPosition.no]);

  const restingYesAsks =
    publicKey === null || publicKey === undefined ? [] : book.asks.filter((order) => order.owner.equals(publicKey));
  const restingAskQty = restingYesAsks.reduce((sum, o) => sum + o.remaining, 0n);
  const transientState = describeTransientState({ noAvailable: position.netNo, restingAskQty });

  async function execute(action: Action, intent: Intent, key: string) {
    if (publicKey === null || publicKey === undefined || sdkBook === null) {
      return;
    }
    const plan = toInstructionPlan(intent, intentPosition, sdkBook);
    if ("code" in plan) {
      setLastError(guidanceCopy(plan.code));
      return;
    }
    setBusy(key);
    setLastError(null);
    try {
      const usdcMint = await fetchUsdcMint(program);
      const ctx: BuildCtx = { program, user: publicKey, market: market.pubkey, usdcMint };
      const ix = await planToInstruction(ctx, plan);
      await sendTx(connection, sendTransaction, [ix], publicKey);
      setQtyInput("1");
      setPriceInput("");
    } catch (error) {
      setLastError(mapSendError(error));
    } finally {
      setBusy(null);
    }
  }

  function submit(action: Action) {
    if (qty === undefined || (kind === "limit" && price === undefined)) {
      setLastError(guidanceCopy("invalid"));
      return;
    }
    void execute(action, { action, kind, qty, price }, action);
  }

  const now = Math.floor(Date.now() / 1000);
  const isSettled = market.state === "settled";
  const isPastCloseAwaitingSettlement = !isSettled && now >= Number(market.closeTs);
  const isPaused = config?.paused === true;
  const noWallet = publicKey === null || publicKey === undefined;

  if (isSettled) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <p>{settledOutcomeCopy(market.outcome === "yes" ? "yes" : "no", market.settlementPrice)}</p>
        <Link href="/portfolio" className="mt-2 inline-block underline">
          {REDEEM_IN_PORTFOLIO}
        </Link>
      </div>
    );
  }

  if (isPastCloseAwaitingSettlement) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <p>{SETTLEMENT_PENDING}</p>
      </div>
    );
  }

  // Both the book and the wallet's position must be loaded for THIS market
  // before any action can be taken (item 7): a market switch resets both
  // hooks' state, so `loading`/`unknown` here always reflect the current
  // market, never a stale snapshot from the previous one.
  const snapshotsLoading = book.loading || position.loading;
  const disabledReason = noWallet
    ? CONNECT_WALLET
    : snapshotsLoading || position.unknown
      ? CHECKING_POSITION
      : isPaused
        ? TRADING_PAUSED
        : null;

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="sr-only">{HOLDINGS_LABEL}</span>
        <span className="rounded-full border border-yes/40 bg-yes/10 px-2 py-0.5 text-yes">Yes {position.yes.toString()}</span>
        <span className="rounded-full border border-no/40 bg-no/10 px-2 py-0.5 text-no">No {position.no.toString()}</span>
        {position.pairsHeld > 0n ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-text-muted">
            {MINTED_PAIR} {position.pairsHeld.toString()}
          </span>
        ) : null}
      </div>
      {transientState === "noHeldYesResting" ? <p className="mt-2 text-sm text-text-muted">{NO_HELD_YES_RESTING}</p> : null}

      <div className="mt-3 inline-flex rounded-md border border-border p-0.5">
        <button
          type="button"
          aria-pressed={kind === "market"}
          className={`rounded-sm px-3 py-1 text-sm ${kind === "market" ? "bg-indigo text-on-brand" : "text-text-muted hover:text-text"}`}
          onClick={() => setKind("market")}
        >
          {KIND_LABEL.market}
        </button>
        <button
          type="button"
          aria-pressed={kind === "limit"}
          className={`rounded-sm px-3 py-1 text-sm ${kind === "limit" ? "bg-indigo text-on-brand" : "text-text-muted hover:text-text"}`}
          onClick={() => setKind("limit")}
        >
          {KIND_LABEL.limit}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <label className="flex flex-col text-sm">
          Quantity
          <input
            className="num mt-1 w-28 rounded-md border border-border bg-surface px-2 py-1 text-sm disabled:bg-surface-raised"
            type="text"
            inputMode="numeric"
            value={qtyInput}
            onChange={(e) => setQtyInput(e.target.value)}
            disabled={disabledReason !== null}
          />
        </label>
        {kind === "limit" ? (
          <label className="flex flex-col text-sm">
            Price ($)
            <input
              className="num mt-1 w-28 rounded-md border border-border bg-surface px-2 py-1 text-sm disabled:bg-surface-raised"
              type="text"
              inputMode="decimal"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              disabled={disabledReason !== null}
            />
          </label>
        ) : null}
        <div className="flex items-end gap-1 pb-0.5">
          {QTY_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="num rounded-sm border border-border px-2 py-1 text-xs text-text-muted hover:border-indigo/50 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabledReason !== null}
              onClick={() => setQtyInput(preset)}
            >
              {preset}
            </button>
          ))}
          {position.yes > 0n ? (
            <button
              type="button"
              className="rounded-sm border border-border px-2 py-1 text-xs text-text-muted hover:border-indigo/50 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabledReason !== null}
              onClick={() => setQtyInput(position.yes.toString())}
            >
              Max Yes
            </button>
          ) : null}
          {position.no > 0n ? (
            <button
              type="button"
              className="rounded-sm border border-border px-2 py-1 text-xs text-text-muted hover:border-indigo/50 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabledReason !== null}
              onClick={() => setQtyInput(position.no.toString())}
            >
              Max No
            </button>
          ) : null}
        </div>
      </div>

      {noWallet ? (
        <div className="mt-3">
          <EmptyState>{CONNECT_WALLET}</EmptyState>
        </div>
      ) : disabledReason !== null ? (
        <p className="mt-3 text-sm text-text-muted">{disabledReason}</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {ACTIONS.map((action) => {
            const plan = plans[action];

            // Either leg of a held pair may be sold on its own (selling Yes
            // out of a pair simply leaves the No), so gate on what the wallet
            // actually holds, not on the net of the two legs.
            const noHoldings = (action === "sellYes" && position.yes <= 0n) || (action === "sellNo" && position.no <= 0n);
            const guidance = noHoldings
              ? action === "sellYes"
                ? NO_YES_TO_SELL
                : NO_NO_TO_SELL
              : plan !== undefined && "code" in plan
                ? guidanceCopy(plan.code)
                : null;
            const isBuy = action === "buyYes" || action === "buyNo";
            let estimate: string | null = null;
            let winLabel: string | null = null;
            if (!noHoldings && plan !== undefined && !("code" in plan)) {
              if (plan.ix === "buy_no_limit") {
                estimate = lockedUntilFilledLabel(plan.qty * 1_000_000n, 1_000_000n - plan.price);
              } else if (plan.ix === "place_order" && plan.estimate.deposit !== undefined) {
                estimate = lockedUntilFilledLabel(plan.estimate.deposit);
              } else {
                estimate = estimateLabel(plan.estimate.cost);
                if (isBuy && qty !== undefined && sdkBook !== null) {
                  const matchedQty = matchedBuyQty(action as "buyYes" | "buyNo", kind, qty, sdkBook);
                  winLabel = winIfRightLabel(matchedQty, qty);
                }
              }
            }

            return (
              <div key={action} className="flex flex-col">
                <button
                  type="button"
                  className={`rounded-md border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${ACTION_STYLE[action]}`}
                  disabled={noHoldings || busy !== null || plan === undefined}
                  onClick={() => submit(action)}
                >
                  {busy === action ? SENDING : ACTION_LABEL[action]}
                </button>
                {estimate !== null ? <span className="num mt-1 text-xs text-text-muted">{estimate}</span> : null}
                {winLabel !== null ? <span className="num text-xs text-text-muted">{winLabel}</span> : null}
                {guidance !== null ? <span className="mt-1 text-xs text-text-muted">{guidance}</span> : null}
              </div>
            );
          })}
        </div>
      )}

      {lastError !== null ? <p className="mt-2 text-sm text-no">{lastError}</p> : null}
    </div>
  );
}
