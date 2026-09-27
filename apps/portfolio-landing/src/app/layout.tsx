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
  metadataBase: new URL("https://aviation.ricothen.com"),
  title: "Aviation Systems Portfolio — senior full-stack, Singapore",
  description:
    "Three production-shaped aviation systems — turnaround command center, maintenance RAG " +
    "copilot, passenger disruption concierge — built end-to-end in TypeScript/Next.js with " +
    "applied AI. Measured, not claimed. Simulated data for portfolio purposes.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-dvh antialiased">
        <a
          href="#systems"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-raised focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to the three systems
        </a>
        <div className="flex min-h-dvh flex-col">
          <main className="flex-1">{children}</main>
          <footer className="border-t border-border">
            <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-muted sm:flex-row">
              <Disclaimer />
              <span>
                No affiliation with any real company or airline ·{" "}
                <a
                  className="underline decoration-border underline-offset-2 hover:text-fg"
                  href="https://github.com/ricothenfx/aviation"
                >
                  github.com/ricothenfx/aviation
                </a>
              </span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
