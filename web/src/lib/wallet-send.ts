"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import type { Connection, Transaction, TransactionSignature } from "@solana/web3.js";
import { useCallback } from "react";

/**
 * Returns a `(tx, connection) => signature` function with the same shape as
 * `useWallet().sendTransaction`, but the wallet only SIGNS: the app
 * broadcasts the signed transaction through its own RPC connection.
 *
 * Why: `sendTransaction` asks the wallet to broadcast through the wallet's
 * own RPC. Phantom in Localnet mode cannot do that and fails with an opaque
 * "Unexpected error", and on any network the wallet's RPC may differ from
 * the one the app reads from. Signing locally and sending through the app's
 * connection makes the path deterministic; wallets without `signTransaction`
 * fall back to their own `sendTransaction`.
 */
export function useSendTransaction(): (tx: Transaction, connection: Connection) => Promise<TransactionSignature> {
  const { signTransaction, sendTransaction } = useWallet();
  return useCallback(
    async (tx: Transaction, connection: Connection) => {
      if (signTransaction) {
        const signed = await signTransaction(tx);
        return connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
      }
      return sendTransaction(tx, connection);
    },
    [signTransaction, sendTransaction],
  );
}
