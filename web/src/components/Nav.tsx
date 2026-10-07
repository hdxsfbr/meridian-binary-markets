"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

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
