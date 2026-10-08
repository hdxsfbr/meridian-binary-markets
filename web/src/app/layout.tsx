import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { WalletProviders } from "@/lib/wallet";
import { AppDataProvider } from "@/hooks/AppDataProvider";
import { Nav } from "@/components/Nav";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Meridian",
  icons: {
    icon: "/brand/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <body className="bg-bg text-text">
        <WalletProviders>
          <AppDataProvider>
            <Nav />
            <main className="min-h-screen">{children}</main>
          </AppDataProvider>
        </WalletProviders>
      </body>
    </html>
  );
}
