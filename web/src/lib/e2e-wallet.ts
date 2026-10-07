"use client";

/**
 * Test-only Wallet Standard wallet for the Playwright smoke suite
 * (tasks.md T066/T075/T080). Registers a wallet named "Test Wallet" via the
 * Wallet Standard `wallet-standard:register-wallet` window event
 * (https://github.com/wallet-standard/wallet-standard) so
 * `@solana/wallet-adapter-react`'s `WalletProvider` picks it up
 * automatically -- it already runs every detected adapter through
 * `@solana/wallet-standard-wallet-adapter-react`'s `useStandardWalletAdapters`
 * internally (see that package's `WalletProvider.js`), so no adapter class
 * or `wallets` array entry is needed on our side, unlike Phantom/Solflare in
 * `wallet.tsx`. Implemented against the bare event-and-object protocol
 * instead of the `@wallet-standard/*` helper packages: those are only
 * available transitively (via `@solana/wallet-adapter-wallets`), and this is
 * the one place in the app that would need them as direct dependencies --
 * simpler to hand-roll the dozen-line registration handshake than add them.
 *
 * SECURITY: everything here is inert unless outside production AND
 * `NEXT_PUBLIC_E2E === "1"`, a build-time flag only ever set by
 * `make test-web`'s own `next dev` invocation -- never in a real
 * deployment. Even then, the keypair it signs with is never a real secret:
 * `web/e2e/seed.ts` generates it fresh against a disposable local
 * validator, and Playwright hands it to this file at runtime via
 * `window.__MERIDIAN_E2E_SECRET__` (set per test with `page.addInitScript`,
 * before any app code runs -- this is how different spec files can drive
 * different wallets, e.g. the real admin keypair in `admin.spec.ts`,
 * against the one `next dev` process the whole suite shares). There is no
 * env-var fallback for the secret: it must always come from
 * `window.__MERIDIAN_E2E_SECRET__`, so no signing material ever lives in a
 * `NEXT_PUBLIC_*` variable or client bundle.
 */

import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";

declare global {
  interface Window {
    __MERIDIAN_E2E_SECRET__?: string;
  }
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Minimal base58 decoder (Bitcoin alphabet). `web/e2e/seed.ts` carries the
 * matching encoder; neither side pulls in a `bs58` dependency just for this
 * one test fixture's secret-key encoding.
 */
function decodeBase58(input: string): Uint8Array {
  const bytes = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error(`e2e-wallet: "${char}" is not a valid base58 character`);
    }
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const char of input) {
    if (char !== BASE58_ALPHABET[0]) break;
    leadingZeros += 1;
  }
  return Uint8Array.from([...new Array(leadingZeros).fill(0), ...bytes.reverse()]);
}

/** Matches `@solana/wallet-standard-util`'s `getChainForEndpoint` for any `127.0.0.1`/`localhost` RPC URL. */
const SOLANA_LOCALNET_CHAIN = "solana:localnet";
const WALLET_NAME = "Test Wallet";
// A 1x1 transparent SVG: the minimal value the Wallet Standard's `icon`
// field (a `data:image/...` URI) requires every wallet to supply.
const WALLET_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4=";

type ChangeListener = (properties: Record<string, unknown>) => void;

function signRawTransaction(bytes: Uint8Array, keypair: Keypair): Uint8Array {
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([keypair]);
    return versioned.serialize();
  } catch {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(keypair);
    return new Uint8Array(legacy.serialize({ requireAllSignatures: false, verifySignatures: false }));
  }
}

function buildWallet(keypair: Keypair) {
  const account = {
    address: keypair.publicKey.toBase58(),
    publicKey: keypair.publicKey.toBytes(),
    chains: [SOLANA_LOCALNET_CHAIN],
    features: ["solana:signTransaction"],
    label: WALLET_NAME,
    icon: WALLET_ICON,
  };

  const listeners = new Set<ChangeListener>();

  return {
    version: "1.0.0" as const,
    name: WALLET_NAME,
    icon: WALLET_ICON,
    chains: [SOLANA_LOCALNET_CHAIN],
    accounts: [account],
    features: {
      "standard:connect": {
        version: "1.0.0" as const,
        connect: async () => ({ accounts: [account] }),
      },
      "standard:disconnect": {
        version: "1.0.0" as const,
        disconnect: async () => {},
      },
      "standard:events": {
        version: "1.0.0" as const,
        on: (event: string, listener: ChangeListener) => {
          if (event !== "change") {
            return () => {};
          }
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      "solana:signTransaction": {
        version: "1.0.0" as const,
        // `StandardWalletAdapter`'s constructor reads this unconditionally
        // (`arraysEqual` over it) -- omitting it throws `Cannot read
        // properties of undefined (reading 'length')` before the adapter
        // even finishes constructing, which otherwise looks like the wallet
        // never registered at all.
        supportedTransactionVersions: ["legacy", 0] as const,
        signTransaction: async (...inputs: Array<{ transaction: Uint8Array }>) =>
          inputs.map((input) => ({ signedTransaction: signRawTransaction(input.transaction, keypair) })),
      },
    },
  };
}

type Wallet = ReturnType<typeof buildWallet>;
type RegisterCallback = (wallet: Wallet) => void;

let installedFor: string | null = null;

/**
 * Builds the keypair from `window.__MERIDIAN_E2E_SECRET__` (injected per
 * test via `page.addInitScript`) and registers it as a Wallet Standard
 * wallet. A no-op in production, outside `NEXT_PUBLIC_E2E === "1"`, with no
 * secret configured, or if this exact secret is already registered
 * (re-running on a re-render must never register duplicate wallets).
 */
export function installE2eWallet(): void {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_E2E !== "1" ||
    typeof window === "undefined"
  ) {
    return;
  }
  const secretBase58 = window.__MERIDIAN_E2E_SECRET__;
  if (!secretBase58 || secretBase58 === installedFor) {
    return;
  }
  installedFor = secretBase58;

  const keypair = Keypair.fromSecretKey(decodeBase58(secretBase58));
  const wallet = buildWallet(keypair);

  // The Wallet Standard registration handshake: a wallet dispatches
  // `register-wallet` immediately (for an app whose `getWallets()` listener
  // is already up) and also listens for `app-ready` (for an app that sets
  // its listener up after this file has already run) -- both paths end by
  // calling the app-supplied `register` callback with this wallet.
  const callback = (api: { register: RegisterCallback }) => api.register(wallet);
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
  window.addEventListener("wallet-standard:app-ready", ((event: CustomEvent<{ register: RegisterCallback }>) => {
    callback(event.detail);
  }) as EventListener);
}
