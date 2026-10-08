"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { useConfig } from "@/hooks/useConfig";
import { usePrices } from "@/hooks/usePrices";
import { formatUsd } from "@/lib/format";

// The wallet button's label depends on wallet state that only exists in the
// browser (detected extensions, autoconnect), so it is rendered client-side
// only; a server render would always say "Select Wallet" and mismatch.
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

const LINKS: Array<{ href: string; label: string; match: (path: string) => boolean }> = [
  { href: "/markets", label: "Markets", match: (p) => p === "/markets" },
  { href: "/trade", label: "Trade", match: (p) => p.startsWith("/trade") },
  { href: "/portfolio", label: "Portfolio", match: (p) => p === "/portfolio" },
  { href: "/history", label: "History", match: (p) => p === "/history" },
];

export function Nav() {
  const pathname = usePathname() ?? "/";
  const config = useConfig();
  const prices = usePrices();
  const tickers = config?.tickers ?? [];

  return (
    <nav className="flex items-center justify-between gap-2 border-b border-border bg-midnight px-3 py-3 sm:gap-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2 sm:gap-6 lg:shrink-0">
        <Link href="/" className="flex shrink-0 items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/logo-dark.svg"
            alt="Meridian"
            width={128}
            height={28}
            className="logo-theme-dark hidden sm:block"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/logo.svg"
            alt="Meridian"
            width={128}
            height={28}
            className="logo-theme-light hidden sm:block"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-mark.svg" alt="Meridian" width={28} height={28} className="block sm:hidden" />
        </Link>
        <div className="-mx-1 flex min-w-0 items-center gap-2 overflow-x-auto px-1 py-1 sm:gap-6 lg:overflow-visible">
          {LINKS.map((link) => {
            const active = link.match(pathname);
            return (
              <Link
                key={link.label}
                href={link.href}
                className={`shrink-0 whitespace-nowrap border-b-2 py-1 text-xs font-medium sm:text-sm ${
                  active ? "border-cyan text-text" : "border-transparent text-text-muted hover:text-text"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
      <div className="ticker-tape hidden min-w-0 flex-1 lg:block" aria-label="Ticker prices">
        <div className="ticker-tape-track">
          {[0, 1].map((copy) => (
            <div key={copy} className="ticker-tape-group" aria-hidden={copy === 1}>
              {tickers.map((ticker) => (
                <Link
                  key={`${copy}-${ticker}`}
                  href={`/trade/${ticker}`}
                  tabIndex={copy === 1 ? -1 : undefined}
                  className="flex shrink-0 items-center gap-1.5 text-xs text-text-muted hover:text-text"
                >
                  <span className="font-medium">{ticker}</span>
                  <span className="num">{prices[ticker]?.priceMicro !== undefined ? formatUsd(prices[ticker]!.priceMicro) : "—"}</span>
                </Link>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="shrink-0">
        <WalletMultiButton />
      </div>
    </nav>
  );
}
