"use client";

/**
 * Builds the on-chain Anchor `Program` client shared by the read hooks
 * (`useConfig`, `useMarkets`, `usePrices`; `useBook` is Wave 5). Reuses
 * `web/src/lib/rpc.ts`'s connection/program-id plumbing and `@meridian/sdk`'s
 * generated `IDL`, with the IDL's baked-in `address` overridden to
 * `NEXT_PUBLIC_PROGRAM_ID` so the deployed program id is always driven by
 * environment configuration, not by whatever id was current when the IDL
 * was last generated.
 *
 * Without a connected wallet, falls back to a throwaway keypair wallet so
 * account reads still work before anyone connects (FR-026 scenario 4:
 * browsing works without a wallet). That fallback is never used to send a
 * transaction from any of this wave's hooks, which only read accounts.
 *
 * The fallback is a small object implementing `@anchor-lang/core`'s
 * `Wallet` shape directly (signs with a throwaway `Keypair`) rather than
 * using the package's own `Wallet` class: that class is only exported from
 * the Node/CJS build, not the browser bundle Next.js resolves for client
 * components, and importing it breaks the production build.
 */

import { useMemo } from "react";
import { Keypair, type PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program, type Idl } from "@anchor-lang/core";
import { IDL } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";

const PROGRAM_IDL = { ...IDL, address: PROGRAM_ID.toBase58() } as unknown as Idl;

/**
 * Read-only fallback wallet used before anyone connects (FR-026 scenario 4:
 * browsing works without a wallet). It has a real keypair only so account
 * reads that need *some* `publicKey` still work; it must never actually
 * sign a transaction a user did not authorize, so both signing methods
 * refuse with user-facing copy the UI can show as-is.
 */
function readOnlyWallet() {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> => {
      throw new Error("Connect a wallet to trade.");
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> => {
      throw new Error("Connect a wallet to trade.");
    },
  };
}

/** Builds (and memoizes) the Anchor program client for the current connection/wallet pair. */
export function useProgram(): Program {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();

  return useMemo(() => {
    const wallet =
      publicKey && signTransaction && signAllTransactions
        ? { publicKey, signTransaction, signAllTransactions }
        : readOnlyWallet();

    const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
    return new Program(PROGRAM_IDL, provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, publicKey, signTransaction, signAllTransactions]);
}

/**
 * The generic `Program<Idl>` (as returned by `useProgram`) types `.account`
 * as an empty object, since the base `Idl` interface carries no literal
 * account names for the namespace mapped type to key off. The actual
 * `AccountClient` for each account name exists at runtime regardless (it's
 * built from the real, camelCased account list inside `Program`'s
 * constructor); this narrows just enough to call it without losing type
 * safety on every other `Program` member.
 */
export type AccountClientLike = {
  fetchNullable(address: PublicKey, commitment?: string): Promise<unknown>;
  all(filters?: unknown): Promise<Array<{ publicKey: PublicKey; account: unknown }>>;
};

/** Looks up an account namespace client by its camelCased account name (e.g. `"market"`). */
export function accountClient(program: Program, name: string): AccountClientLike {
  return (program.account as unknown as Record<string, AccountClientLike>)[name];
}
