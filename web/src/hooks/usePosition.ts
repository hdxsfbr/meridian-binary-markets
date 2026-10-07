"use client";

/**
 * A wallet's Yes/No position for one market (T062): token balances from
 * its Yes/No associated token accounts (missing ATA tolerated as a `0n`
 * balance, not an error — most wallets have never touched a given
 * market), plus its resting orders from the market's `Book` (`useBook`).
 *
 * Yes/No mints have 6 decimals (`create_market.rs`: `mint::decimals = 6`),
 * so `getTokenAccountBalance` returns micro-units, not contracts; every
 * balance here is divided by `BASE_UNITS_PER_CONTRACT` before being
 * returned, since every on-chain instruction's `qty` (and the
 * trade-panel's `Intent.qty`) counts whole contracts, not base units.
 *
 * `pairsHeld = min(yes, no)` is the gating-exempt amount (intent.ts's
 * `checkGating`/FR-015: a wallet holding equal Yes and No, whether from
 * minting or from trading into that position, is never told to "close"
 * anything); `netYes`/`netNo` are what's left over and is what actually
 * gates the opposite side.
 *
 * `unknown` distinguishes "the ATA does not exist, so the balance is truly
 * 0" from "an RPC call failed and the balance is not actually known yet":
 * only the latter sets `unknown`, so the UI can show "Checking your
 * position…" and disable trading rather than silently treating a flaky RPC
 * response as "you hold nothing".
 */

import { useEffect, useState } from "react";
import type { Connection, PublicKey } from "@solana/web3.js";
import { noMintPda, yesMintPda, type Order } from "@meridian/sdk";
import { associatedTokenAddress } from "@/lib/ata";
import { PROGRAM_ID } from "@/lib/rpc";
import { useBook } from "./useBook";
import { useProgram } from "./useProgram";

/** Yes/No mints have 6 decimals; one contract is this many base units. */
export const BASE_UNITS_PER_CONTRACT = 1_000_000n;

export type UsePositionResult = {
  /** Yes held, whole contracts (base units / 1_000_000). */
  yes: bigint;
  /** No held, whole contracts. */
  no: bigint;
  /** Yes balance beyond any held pair: what actually gates Buy No. */
  netYes: bigint;
  /** No balance beyond any held pair: what actually gates Buy Yes. */
  netNo: bigint;
  /** `min(yes, no)`: gating-exempt, shown as "Minted pair" rather than two positions. */
  pairsHeld: bigint;
  /** This wallet's resting orders on the market's book (owner match), bids then asks. */
  restingOrders: Order[];
  loading: boolean;
  /** True while the current balance is not actually known (RPC failure), as opposed to a confirmed-zero/absent account. */
  unknown: boolean;
};

const REFRESH_INTERVAL_MS = 15_000;

type BalanceResult = { amount: bigint; unknown: boolean };

const ACCOUNT_NOT_FOUND_PATTERNS = ["could not find account", "account not found", "invalid param"];

function isAccountAbsentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return ACCOUNT_NOT_FOUND_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Fetches a token account's balance in whole contracts (base units /
 * `BASE_UNITS_PER_CONTRACT`). An absent ATA (never minted/traded into this
 * market yet) resolves to `{ amount: 0n, unknown: false }` -- not an error.
 * Any other failure (RPC flake, network error) resolves to `{ amount: 0n,
 * unknown: true }`, so callers never mistake "could not check" for "holds
 * nothing".
 */
async function tokenBalance(connection: Connection, ata: PublicKey): Promise<BalanceResult> {
  try {
    const result = await connection.getTokenAccountBalance(ata, "confirmed");
    return { amount: BigInt(result.value.amount) / BASE_UNITS_PER_CONTRACT, unknown: false };
  } catch (error) {
    if (isAccountAbsentError(error)) {
      return { amount: 0n, unknown: false };
    }
    return { amount: 0n, unknown: true };
  }
}

/** The connected wallet's position (balances + resting orders) for `market`. */
export function usePosition(market: PublicKey | undefined, wallet: PublicKey | undefined): UsePositionResult {
  const program = useProgram();
  const book = useBook(market);
  const [balances, setBalances] = useState<{ yes: bigint; no: bigint; unknown: boolean }>({
    yes: 0n,
    no: 0n,
    unknown: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Reset immediately on market/wallet change so a stale snapshot from the
    // previous market is never shown while the new one loads (item 7).
    setBalances({ yes: 0n, no: 0n, unknown: false });
    setLoading(true);

    if (market === undefined || wallet === undefined) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const connection = program.provider.connection;
    const [yesMint] = yesMintPda(PROGRAM_ID, market);
    const [noMint] = noMintPda(PROGRAM_ID, market);
    const yesAta = associatedTokenAddress(wallet, yesMint);
    const noAta = associatedTokenAddress(wallet, noMint);

    async function load() {
      const [yes, no] = await Promise.all([tokenBalance(connection, yesAta), tokenBalance(connection, noAta)]);
      if (!cancelled) {
        setBalances({ yes: yes.amount, no: no.amount, unknown: yes.unknown || no.unknown });
        setLoading(false);
      }
    }

    void load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    const yesSubscriptionId = connection.onAccountChange(yesAta, () => void load(), "confirmed");
    const noSubscriptionId = connection.onAccountChange(noAta, () => void load(), "confirmed");

    return () => {
      cancelled = true;
      clearInterval(interval);
      void connection.removeAccountChangeListener(yesSubscriptionId);
      void connection.removeAccountChangeListener(noSubscriptionId);
    };
  }, [program, market, wallet]);

  const restingOrders: Order[] =
    wallet === undefined ? [] : [...book.bids, ...book.asks].filter((order) => order.owner.equals(wallet));

  const pairsHeld = balances.yes < balances.no ? balances.yes : balances.no;
  const netYes = balances.yes - pairsHeld;
  const netNo = balances.no - pairsHeld;

  return {
    yes: balances.yes,
    no: balances.no,
    netYes,
    netNo,
    pairsHeld,
    restingOrders,
    loading: loading || book.loading,
    unknown: balances.unknown,
  };
}
