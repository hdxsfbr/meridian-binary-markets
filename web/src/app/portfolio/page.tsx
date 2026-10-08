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
import { formatUsd } from "@/lib/format";
import { todayTradingDay } from "@/lib/markets";
import { getUsdcMint, mintPair, redeemPair, redeemWinning, type RedeemMarket } from "@/lib/redeem-tx";
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

  if (!publicKey) {
    return (
      <div className="px-6 py-4">
        <h1 className="text-2xl font-semibold">Portfolio</h1>
        <p className="mt-4">Connect a wallet to see your portfolio.</p>
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

  return (
    <div className="flex flex-col gap-8 px-6 py-4">
      <h1 className="text-2xl font-semibold">Portfolio</h1>

      <section className="flex flex-col gap-2">
        <span className="text-sm text-black/60">USDC balance</span>
        <span className="text-xl font-semibold" data-testid="usdc-balance">
          {usdcBalanceMicro === null ? "—" : formatUsd(usdcBalanceMicro)}
        </span>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-sm text-black/60">Realized P&amp;L</span>
        <span className="text-xl font-semibold">{formatUsd(summary.realizedPnlMicro)}</span>
        {historyError ? (
          <span className="text-sm text-black/60">Could not sync trade history. Retrying…</span>
        ) : !historyLoaded ? (
          <span className="text-sm text-black/60">Syncing history…</span>
        ) : !historyComplete ? (
          <span className="text-sm text-black/60">Partial history</span>
        ) : null}
      </section>

      {actionError ? <p className="text-red-700">{actionError}</p> : null}

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Positions</h2>
        {loading ? <p>Loading…</p> : null}
        {!loading && error ? <p>Could not load your positions. Retrying…</p> : null}
        {!loading && !error && rows.length === 0 ? <p>No positions yet.</p> : null}
        {rows.map((row) => (
          <PositionRow
            key={row.marketKey}
            row={row}
            onRedeemPair={() => handleRedeemPair(row)}
            onRedeemWinning={() => handleRedeemWinning(row)}
            redeemingPair={redeemingKey === `${row.marketKey}:pair`}
            redeemingWinning={redeemingKey === `${row.marketKey}:winning`}
            costBasisPending={!historyLoaded}
          />
        ))}
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
      {myOrders.lastError !== null ? <p className="text-red-700">{myOrders.lastError}</p> : null}
    </div>
  );
}
