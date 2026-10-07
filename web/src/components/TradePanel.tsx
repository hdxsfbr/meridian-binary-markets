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
  closeButtonLabel,
  estimateLabel,
  guidanceCopy,
  settledOutcomeCopy,
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
  const { publicKey, sendTransaction } = useWallet();

  const book = useBook(market.pubkey);
  const position = usePosition(market.pubkey, publicKey ?? undefined);

  const [kind, setKind] = useState<Kind>("market");
  const [qtyInput, setQtyInput] = useState("");
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
      setQtyInput("");
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

  function closeFirst(action: "sellYes" | "sellNo") {
    const closeQty = action === "sellYes" ? intentPosition.yes - position.pairsHeld : intentPosition.no - position.pairsHeld;
    if (closeQty <= 0n) {
      return;
    }
    void execute(action, { action, kind: "market", qty: closeQty }, `close-${action}`);
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

      <div className="mt-2 flex gap-2">
        <button type="button" aria-pressed={kind === "market"} onClick={() => setKind("market")}>
          {KIND_LABEL.market}
        </button>
        <button type="button" aria-pressed={kind === "limit"} onClick={() => setKind("limit")}>
          {KIND_LABEL.limit}
        </button>
      </div>

      <div className="mt-2 flex gap-2">
        <label className="flex flex-col text-sm">
          Quantity
          <input
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
            const isGatingError = plan !== undefined && "code" in plan && (plan.code === "closeNoFirst" || plan.code === "closeYesFirst");

            if (isGatingError) {
              const code = (plan as { code: "closeNoFirst" | "closeYesFirst" }).code;
              const closeAction = code === "closeNoFirst" ? "sellNo" : "sellYes";
              return (
                <div key={action} className="col-span-2 flex items-center justify-between">
                  <span className="text-sm text-black/70">{guidanceCopy(code)}</span>
                  <button type="button" disabled={busy !== null} onClick={() => closeFirst(closeAction)}>
                    {busy === `close-${closeAction}` ? SENDING : closeButtonLabel(code)}
                  </button>
                </div>
              );
            }

            const guidance = plan !== undefined && "code" in plan ? guidanceCopy(plan.code) : null;
            const estimate = plan !== undefined && !("code" in plan) ? estimateLabel(plan.estimate.cost, plan.estimate.fills) : null;

            return (
              <div key={action} className="flex flex-col">
                <button type="button" disabled={busy !== null || plan === undefined} onClick={() => submit(action)}>
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
