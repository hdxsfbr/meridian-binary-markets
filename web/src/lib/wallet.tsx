"use client";

/**
 * Wraps the app in the Solana wallet-adapter providers: connection (RPC +
 * websocket from `NEXT_PUBLIC_*` env), the wallet list, and the connect/select
 * modal. Autoconnects on load.
 *
 * No wallet adapters are registered explicitly: Phantom, Solflare and the
 * other current browser wallets announce themselves through the Wallet
 * Standard and wallet-adapter picks them up automatically. Registering the
 * legacy `PhantomWalletAdapter` alongside that produced a second, never-ready
 * "Phantom" entry in the modal, and choosing it failed with
 * WalletNotReadyError.
 */

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { installE2eWallet } from "./e2e-wallet";

import "@solana/wallet-adapter-react-ui/styles.css";

// Playwright-only test wallet (tasks.md T066/T075/T080); inert unless both
// outside production and `NEXT_PUBLIC_E2E=1`, which only `make test-web`'s
// `next dev` ever sets. The `NODE_ENV` check lets the bundler dead-code
// eliminate `installE2eWallet` (and its `e2e-wallet` import) from
// production builds entirely.
if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_E2E === "1") {
  installE2eWallet();
}

const RPC_ENDPOINT = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const WS_ENDPOINT = process.env.NEXT_PUBLIC_WS_URL ?? "wss://api.devnet.solana.com";
export function WalletProviders({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={{ wsEndpoint: WS_ENDPOINT, commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
