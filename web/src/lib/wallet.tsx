"use client";

/**
 * Wraps the app in the Solana wallet-adapter providers: connection (RPC +
 * websocket from `NEXT_PUBLIC_*` env), the wallet list (Phantom, Solflare),
 * and the connect/select modal. Autoconnects on load.
 */

import { useMemo } from "react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";

import "@solana/wallet-adapter-react-ui/styles.css";

const RPC_ENDPOINT = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const WS_ENDPOINT = process.env.NEXT_PUBLIC_WS_URL ?? "wss://api.devnet.solana.com";
const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";

/**
 * Maps `NEXT_PUBLIC_CLUSTER` to the `WalletAdapterNetwork` the Solflare adapter
 * wants. `WalletAdapterNetwork` has no "localnet" member, so a local validator
 * is mapped to `Devnet` as the closest available setting. Mainnet is never
 * returned here, regardless of the configured cluster.
 */
function solflareNetwork(cluster: string): WalletAdapterNetwork {
  switch (cluster) {
    case "devnet":
      return WalletAdapterNetwork.Devnet;
    case "localnet":
      return WalletAdapterNetwork.Devnet; // closest available setting; see doc comment above.
    default:
      return WalletAdapterNetwork.Devnet;
  }
}

export function WalletProviders({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network: solflareNetwork(CLUSTER) })],
    [],
  );

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={{ wsEndpoint: WS_ENDPOINT }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
