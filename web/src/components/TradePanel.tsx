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
  describeTransientState,
  toInstructionPlan,
} from "@meridian/sdk";
import type { ConfigSnapshot } from "@/hooks/useConfig";
import type { MarketAccount } from "@/hooks/useMarkets";
import { useBook } from "@/hooks/useBook";
import { usePosition } from "@/hooks/usePosition";
import { useProgram } from "@/hooks/useProgram";
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
} from "@/lib/trade-copy";

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
      <div className="rounded border border-black/10 p-4">
        <p>{settledOutcomeCopy(market.outcome === "yes" ? "yes" : "no", market.settlementPrice)}</p>
        <Link href="/portfolio" className="mt-2 inline-block underline">
          {REDEEM_IN_PORTFOLIO}
        </Link>
      </div>
    );
  }

  if (isPastCloseAwaitingSettlement) {
    return (
      <div className="rounded border border-black/10 p-4">
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
    <div className="rounded border border-black/10 p-4">
      {position.pairsHeld > 0n ? (
        <p className="text-sm text-black/70">
          {MINTED_PAIR}: {position.pairsHeld.toString()}
        </p>
      ) : null}
      {transientState === "noHeldYesResting" ? <p className="text-sm text-black/70">{NO_HELD_YES_RESTING}</p> : null}

      <p className="text-sm text-black/70">
        {HOLDINGS_LABEL}: {position.yes.toString()} Yes · {position.no.toString()} No
      </p>

      <div className="mt-2 flex gap-2">
        <button type="button" aria-pressed={kind === "market"} className={`rounded border px-3 py-1 text-sm ${kind === "market" ? "border-black bg-black text-white" : "border-black/20 text-black/70 hover:border-black/50"}`} onClick={() => setKind("market")}>
          {KIND_LABEL.market}
        </button>
        <button type="button" aria-pressed={kind === "limit"} className={`rounded border px-3 py-1 text-sm ${kind === "limit" ? "border-black bg-black text-white" : "border-black/20 text-black/70 hover:border-black/50"}`} onClick={() => setKind("limit")}>
          {KIND_LABEL.limit}
        </button>
      </div>

      <div className="mt-2 flex gap-2">
        <label className="flex flex-col text-sm">
          Quantity
          <input
            className="mt-1 w-32 rounded border border-black/20 px-2 py-1 text-sm disabled:bg-black/5"
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
              className="mt-1 w-32 rounded border border-black/20 px-2 py-1 text-sm disabled:bg-black/5"
              type="text"
              inputMode="decimal"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              disabled={disabledReason !== null}
            />
          </label>
        ) : null}
      </div>

      {disabledReason !== null ? (
        <p className="mt-2 text-sm text-black/70">{disabledReason}</p>
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
            let estimate: string | null = null;
            if (!noHoldings && plan !== undefined && !("code" in plan)) {
              if (plan.ix === "buy_no_limit") {
                estimate = lockedUntilFilledLabel(plan.qty * 1_000_000n, 1_000_000n - plan.price);
              } else if (plan.ix === "place_order" && plan.estimate.deposit !== undefined) {
                estimate = lockedUntilFilledLabel(plan.estimate.deposit);
              } else {
                estimate = estimateLabel(plan.estimate.cost, plan.estimate.fills);
              }
            }

            return (
              <div key={action} className="flex flex-col">
                <button type="button" className="rounded border border-black/20 bg-black px-3 py-2 text-sm font-medium text-white hover:bg-black/80 disabled:cursor-not-allowed disabled:bg-black/30" disabled={noHoldings || busy !== null || plan === undefined} onClick={() => submit(action)}>
                  {busy === action ? SENDING : ACTION_LABEL[action]}
                </button>
                {estimate !== null ? <span className="text-xs text-black/70">{estimate}</span> : null}
                {guidance !== null ? <span className="text-xs text-black/70">{guidance}</span> : null}
              </div>
            );
          })}
        </div>
      )}

      {lastError !== null ? <p className="mt-2 text-sm text-red-700">{lastError}</p> : null}
    </div>
  );
}
