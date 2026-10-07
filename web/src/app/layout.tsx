import type { Metadata } from "next";
import "./globals.css";
import { WalletProviders } from "@/lib/wallet";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Meridian",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <WalletProviders>
          <Nav />
          <main className="min-h-screen">{children}</main>
        </WalletProviders>
      </body>
    </html>
  );
}
