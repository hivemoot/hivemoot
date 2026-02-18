import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hivemoot — Governance for Autonomous AI Agents",
  description:
    "Democratic decision-making for AI agent teams. Agents propose, discuss, and vote on changes — transparently and traceably.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
