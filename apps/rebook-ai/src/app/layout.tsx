import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { Disclaimer } from "@aviation/ui";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Rebook.ai — Passenger Disruption Concierge",
  description:
    "Proactive rebooking offers in seconds, with a supervised agentic workflow for duty agents. " +
    "Simulated data for portfolio purposes.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-dvh antialiased">
        <div className="flex min-h-dvh flex-col">
          <main className="flex-1">{children}</main>
          <footer className="border-t border-border px-4 py-2 text-center text-xs text-muted">
            <Disclaimer />
          </footer>
        </div>
      </body>
    </html>
  );
}
