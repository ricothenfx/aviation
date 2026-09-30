import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { Disclaimer, THEME_INIT_SCRIPT, ThemeToggle } from "@aviation/ui";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MRO Copilot — Maintenance Manual Copilot",
  description:
    "Grounded maintenance-manual copilot with citations, guardrails and engine health. " +
    "Simulated data for portfolio purposes.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        {/* Applies the stored theme to <html> before first paint (ADR-0020). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <div className="flex min-h-dvh flex-col">
          <main className="flex-1">{children}</main>
          <footer className="border-t border-border px-4 py-2 text-center text-xs text-muted">
            <div className="flex items-center justify-center gap-3">
              <Disclaimer />
              <ThemeToggle />
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
