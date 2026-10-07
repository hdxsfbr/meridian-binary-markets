"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";

// The wallet button's label depends on wallet state that only exists in the
// browser (detected extensions, autoconnect), so it is rendered client-side
// only; a server render would always say "Select Wallet" and mismatch.
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

const LINKS: Array<{ href: string; label: string; match: (path: string) => boolean }> = [
  { href: "/markets", label: "Markets", match: (p) => p === "/markets" },
  { href: "/markets", label: "Trade", match: (p) => p.startsWith("/trade") },
  { href: "/portfolio", label: "Portfolio", match: (p) => p === "/portfolio" },
  { href: "/history", label: "History", match: (p) => p === "/history" },
];

export function Nav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="flex items-center justify-between border-b border-black/10 px-6 py-4">
      <div className="flex items-center gap-6">
        <Link href="/" className="text-lg font-semibold">
          Meridian
        </Link>
        {LINKS.map((link) => (
          <Link
            key={link.label}
            href={link.href}
            className={link.match(pathname) ? "font-semibold underline" : "text-black/70"}
          >
            {link.label}
          </Link>
        ))}
      </div>
      <WalletMultiButton />
    </nav>
  );
}
