"use client";

/**
 * T078: Portfolio page -- USDC balance, open positions, settled outcomes
 * with redeem actions, pairs held, realized P&L, and the market-maker panel
 * (contracts/frontend.md `/portfolio` row; FR-022...FR-028, FR-034).
 */

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSendTransaction } from "../../lib/wallet-send";
import { PlaceOrderSide, TimeInForce } from "@meridian/sdk";
import { associatedTokenAddress } from "@/lib/ata";
import { formatSignedUsd, formatUsd } from "@/lib/format";
import { todayTradingDay } from "@/lib/markets";
import {
  buildRedeemPairInstruction,
  buildRedeemWinningInstruction,
  getUsdcMint,
  mintPair,
  redeemPair,
  redeemWinning,
  type RedeemMarket,
} from "@/lib/redeem-tx";
import { chunk, planRedeemAll, redeemableMicro, REDEEM_ALL_CHUNK_SIZE } from "@/lib/redeem-all";
import { fetchUsdcMint, mapSendError, placeOrder, sendTx, type BuildCtx } from "@/lib/tx";
import type { MarketLike, PositionRowData } from "@/lib/positions-view";
import { restingTotalsByMarket, type MyOrderRow } from "@/lib/maker-view";
import type { QuoteSide } from "@/components/MakerQuoteForm";

function toRedeemMarket(row: PositionRowData): RedeemMarket {
  return { pubkey: row.marketPubkey, yesMint: row.yesMint, noMint: row.noMint, vault: row.vault };
}
import { useConfig } from "@/hooks/useConfig";
import { useMyOrders } from "@/hooks/useMyOrders";
import { usePositions } from "@/hooks/usePositions";
import { useProgram } from "@/hooks/useProgram";
import { PositionRow } from "@/components/PositionRow";
import { MakerPanel } from "@/components/MakerPanel";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineError } from "@/components/ui/InlineError";

/** Rows grouped for display: anything with something to collect first, then open positions, then settled positions with nothing left to collect. */
function groupRows(rows: readonly PositionRowData[]): {
  toCollect: PositionRowData[];
  open: PositionRowData[];
  settled: PositionRowData[];
} {
  const toCollect: PositionRowData[] = [];
  const open: PositionRowData[] = [];
  const settled: PositionRowData[] = [];
  for (const row of rows) {
    if (row.canRedeemWinning || row.canRedeemPair) {
      toCollect.push(row);
    } else if (row.state === "open") {
      open.push(row);
    } else {
      settled.push(row);
    }
  }
  return { toCollect, open, settled };
}

export default function PortfolioPage() {
  const { publicKey } = useWallet();
  const sendTransaction = useSendTransaction();
  const { connection } = useConnection();
  const program = useProgram();
  const config = useConfig();
  const { rows, summary, loading, error, fillsCountByMarket, markets, historyComplete, historyLoaded, historyError, refresh } = usePositions(
    publicKey ?? null,
  );
  const myOrders = useMyOrders(publicKey ?? null);

  const [usdcMint, setUsdcMint] = useState<PublicKey | null>(null);
  const [usdcBalanceMicro, setUsdcBalanceMicro] = useState<bigint | null>(null);
  const [balanceTick, setBalanceTick] = useState(0);
  const [minting, setMinting] = useState(false);
  const [redeemingKey, setRedeemingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [redeemAllProgress, setRedeemAllProgress] = useState<{ current: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUsdcMint(program)
      .then((mint) => {
        if (!cancelled) {
          setUsdcMint(mint);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUsdcMint(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [program]);

  useEffect(() => {
    let cancelled = false;
    async function loadBalance() {
      if (!publicKey || !usdcMint) {
        setUsdcBalanceMicro(null);
        return;
      }
      try {
        const ata = associatedTokenAddress(publicKey, usdcMint);
        const balance = await program.provider.connection.getTokenAccountBalance(ata);
        if (!cancelled) {
          setUsdcBalanceMicro(BigInt(balance.value.amount));
        }
      } catch {
        if (!cancelled) {
          setUsdcBalanceMicro(0n);
        }
      }
    }
    void loadBalance();
    const interval = setInterval(loadBalance, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [publicKey, usdcMint, program, balanceTick]);

  const handleMint = useCallback(
    async (market: MarketLike, qty: bigint) => {
      if (!publicKey || !usdcMint) {
        return;
      }
      setActionError(null);
      setMinting(true);
      try {
        await mintPair(program, connection, sendTransaction, publicKey, market, usdcMint, qty);
        setBalanceTick((n) => n + 1);
        refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Minting pair did not go through. Please try again.");
      } finally {
        setMinting(false);
      }
    },
    [publicKey, usdcMint, program, connection, sendTransaction, refresh],
  );

  const handleRedeemPair = useCallback(
    async (row: (typeof rows)[number]) => {
      if (!publicKey || !usdcMint) {
        return;
      }
      setActionError(null);
      setRedeemingKey(`${row.marketKey}:pair`);
      try {
        await redeemPair(program, connection, sendTransaction, publicKey, toRedeemMarket(row), usdcMint, row.pairsHeld);
        setBalanceTick((n) => n + 1);
        refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Redeeming pair did not go through. Please try again.");
      } finally {
        setRedeemingKey(null);
      }
    },
    [publicKey, usdcMint, program, connection, sendTransaction, refresh],
  );

  const handleSubmitQuote = useCallback(
    async (market: MarketLike, side: QuoteSide, priceMicro: bigint, qty: bigint) => {
      if (!publicKey) {
        throw new Error("Connect a wallet to trade.");
      }
      try {
        const usdcMint = await fetchUsdcMint(program);
        const ctx: BuildCtx = { program, user: publicKey, market: market.pubkey, usdcMint };
        const ix = await placeOrder(ctx, {
          side: side === "bid" ? PlaceOrderSide.Bid : PlaceOrderSide.Ask,
          price: priceMicro,
          qty,
          tif: TimeInForce.Limit,
          makers: [],
        });
        await sendTx(connection, sendTransaction, [ix], publicKey);
        setBalanceTick((n) => n + 1);
        refresh();
        myOrders.refresh();
      } catch (err) {
        throw new Error(mapSendError(err));
      }
    },
    [publicKey, program, connection, sendTransaction, refresh, myOrders],
  );

  const handleRedeemWinning = useCallback(
    async (row: (typeof rows)[number]) => {
      if (!publicKey || !usdcMint || !row.winningSide) {
        return;
      }
      setActionError(null);
      setRedeemingKey(`${row.marketKey}:winning`);
      try {
        const qty = row.winningSide === "yes" ? row.yes : row.no;
        await redeemWinning(program, connection, sendTransaction, publicKey, toRedeemMarket(row), usdcMint, row.winningSide, qty);
        setBalanceTick((n) => n + 1);
        refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Redeeming winning tokens did not go through. Please try again.");
      } finally {
        setRedeemingKey(null);
      }
    },
    [publicKey, usdcMint, program, connection, sendTransaction, refresh],
  );

  /**
   * "Redeem all" (REVAMP_PLAN Wave R4): plans every winning/pair redemption
   * across `rows` (`redeem-all.ts`'s `planRedeemAll`), builds each as an
   * instruction via `redeem-tx.ts`'s pure builders, chunks them at
   * `REDEEM_ALL_CHUNK_SIZE` per transaction, and sends each chunk in turn --
   * one wallet approval per chunk, not per position.
   */
  const handleRedeemAll = useCallback(async () => {
    if (!publicKey || !usdcMint) {
      return;
    }
    const rowsByKey = new Map(rows.map((row) => [row.marketKey, row]));
    const plan = planRedeemAll(rows);
    if (plan.length === 0) {
      return;
    }
    setActionError(null);
    const chunks = chunk(plan, REDEEM_ALL_CHUNK_SIZE);
    setRedeemAllProgress({ current: 0, total: chunks.length });
    // Tracks how many chunks actually landed, so a later chunk failing or
    // being rejected never hides an earlier one that already moved funds:
    // the balance/refresh below fires whenever at least one chunk
    // confirmed, independent of whether the whole run finished.
    let confirmedChunks = 0;
    let failure: { message: string } | null = null;
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        setRedeemAllProgress({ current: i + 1, total: chunks.length });
        try {
          const ixs = await Promise.all(
            chunks[i].map((item) => {
              const row = rowsByKey.get(item.marketKey);
              if (!row) {
                throw new Error("A redeemable position disappeared before it could be redeemed. Try again.");
              }
              const market = toRedeemMarket(row);
              if (item.kind === "winning") {
                return buildRedeemWinningInstruction(program, publicKey, market, usdcMint, item.side, item.qty);
              }
              return buildRedeemPairInstruction(program, publicKey, market, usdcMint, item.qty);
            }),
          );
          await sendTx(connection, sendTransaction, ixs, publicKey);
          confirmedChunks += 1;
        } catch (err) {
          failure = { message: mapSendError(err) };
          break;
        }
      }
    } finally {
      if (confirmedChunks > 0) {
        setBalanceTick((n) => n + 1);
        refresh();
      }
      setRedeemAllProgress(null);
    }
    if (failure) {
      setActionError(
        confirmedChunks > 0
          ? `Collected ${confirmedChunks} of ${chunks.length} batches. The rest did not go through: ${failure.message}`
          : `Redeeming did not go through: ${failure.message}`,
      );
    }
  }, [publicKey, usdcMint, program, connection, sendTransaction, rows, refresh]);

  /** One busy flag for every redeem/mint action on the page (Wave R4 review item 4): while any of them is in flight, the others are disabled, even though each keeps its own "Minting…"/"Redeeming…" label. */
  const busy = minting || redeemingKey !== null || redeemAllProgress !== null;

  if (!publicKey) {
    return (
      <div className="mx-auto max-w-[1440px] px-6 py-4">
        <h1 className="text-2xl font-semibold">Portfolio</h1>
        <div className="mt-4">
          <EmptyState>Connect a wallet to see your portfolio.</EmptyState>
        </div>
      </div>
    );
  }

  // Markets past their close are waiting on settlement: no minting or quoting
  // there, matching the trade panel's "settlement pending" state.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const openMarkets: MarketLike[] = markets
    .filter((m) => m.state === "open" && Number(m.closeTs) > nowSeconds)
    .sort((a, b) => {
      if (a.ticker !== b.ticker) return a.ticker < b.ticker ? -1 : 1;
      if ((a.tradingDay ?? 0) !== (b.tradingDay ?? 0)) return (a.tradingDay ?? 0) - (b.tradingDay ?? 0);
      return a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0;
    });
  const today = todayTradingDay();
  const todaysOpenMarkets = openMarkets.filter((m) => todayTradingDay(Number(m.closeTs) * 1000) === today);
  const paused = config?.paused ?? false;
  const restingTotals = restingTotalsByMarket(myOrders.rows);
  const availableUsdcMicro = usdcBalanceMicro ?? 0n;
  const { toCollect, open, settled } = groupRows(rows);
  const totalRedeemableMicro = redeemableMicro(rows);

  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-8 px-6 py-4">
      <h1 className="text-2xl font-semibold">Portfolio</h1>

      {totalRedeemableMicro > 0n ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <span className="text-sm">
            You have <span className="num font-semibold">{formatUsd(totalRedeemableMicro)}</span> to collect
          </span>
          <button
            type="button"
            onClick={() => void handleRedeemAll()}
            disabled={busy}
            className="rounded-md bg-indigo px-4 py-2 text-sm font-medium text-on-brand disabled:opacity-60"
          >
            {redeemAllProgress !== null ? `Redeeming ${redeemAllProgress.current} of ${redeemAllProgress.total}…` : "Redeem all"}
          </button>
        </Card>
      ) : null}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="flex flex-col gap-1 p-4">
          <span className="text-sm text-text-muted">USDC balance</span>
          <span className="num text-2xl font-semibold" data-testid="usdc-balance">
            {usdcBalanceMicro === null ? "—" : formatUsd(usdcBalanceMicro)}
          </span>
        </Card>

        <Card className="flex flex-col gap-1 p-4">
          <span className="text-sm text-text-muted">Realized P&amp;L</span>
          <span className={`num text-2xl font-semibold ${summary.realizedPnlMicro >= 0n ? "text-success" : "text-warning"}`}>
            {formatSignedUsd(summary.realizedPnlMicro)}
          </span>
          {historyError ? (
            <span className="text-sm text-text-muted">Could not sync trade history. Retrying…</span>
          ) : !historyLoaded ? (
            <span className="text-sm text-text-muted">Updating your trade history…</span>
          ) : !historyComplete ? (
            <span className="text-sm text-text-muted">Older activity still loading</span>
          ) : null}
        </Card>
      </section>

      {actionError ? <InlineError>{actionError}</InlineError> : null}

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Positions</h2>
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : null}
        {!loading && error ? <InlineError>Could not load your positions. Retrying…</InlineError> : null}
        {!loading && !error && rows.length === 0 ? <EmptyState>No positions yet.</EmptyState> : null}

        {!loading && !error && toCollect.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-text-muted">To collect</h3>
            {toCollect.map((row) => (
              <PositionRow
                key={row.marketKey}
                row={row}
                onRedeemPair={() => handleRedeemPair(row)}
                onRedeemWinning={() => handleRedeemWinning(row)}
                redeemingPair={redeemingKey === `${row.marketKey}:pair`}
                redeemingWinning={redeemingKey === `${row.marketKey}:winning`}
                busy={busy}
                costBasisPending={!historyLoaded}
              />
            ))}
          </div>
        ) : null}

        {!loading && !error && open.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-text-muted">Open</h3>
            {open.map((row) => (
              <PositionRow
                key={row.marketKey}
                row={row}
                onRedeemPair={() => handleRedeemPair(row)}
                onRedeemWinning={() => handleRedeemWinning(row)}
                redeemingPair={redeemingKey === `${row.marketKey}:pair`}
                redeemingWinning={redeemingKey === `${row.marketKey}:winning`}
                busy={busy}
                costBasisPending={!historyLoaded}
              />
            ))}
          </div>
        ) : null}

        {!loading && !error && settled.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-text-muted">Settled</h3>
            {settled.map((row) => (
              <PositionRow
                key={row.marketKey}
                row={row}
                onRedeemPair={() => handleRedeemPair(row)}
                onRedeemWinning={() => handleRedeemWinning(row)}
                redeemingPair={redeemingKey === `${row.marketKey}:pair`}
                redeemingWinning={redeemingKey === `${row.marketKey}:winning`}
                busy={busy}
                costBasisPending={!historyLoaded}
              />
            ))}
          </div>
        ) : null}
      </section>

      <MakerPanel
        openMarkets={openMarkets}
        quoteMarkets={todaysOpenMarkets}
        rows={rows}
        fillsCountByMarket={fillsCountByMarket}
        restingTotalsByMarket={restingTotals}
        realizedPnlMicro={summary.realizedPnlMicro}
        onMint={handleMint}
        disabled={paused}
        minting={minting}
        busy={busy}
        availableUsdcMicro={availableUsdcMicro}
        onSubmitQuote={handleSubmitQuote}
        myOrders={myOrders.rows}
        onCancelOrder={async (row: MyOrderRow) => {
          await myOrders.cancelOne(row);
          setBalanceTick((n) => n + 1);
        }}
        onCancelAllOnMarket={async (marketKey: string) => {
          await myOrders.cancelAllOnMarket(marketKey);
          setBalanceTick((n) => n + 1);
        }}
        cancelling={myOrders.cancelling}
        myOrdersError={myOrders.error}
        booksByMarket={myOrders.books}
      />
      {myOrders.lastError !== null ? <InlineError>{myOrders.lastError}</InlineError> : null}
    </div>
  );
}
