import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hivemoot — Your Own AI Engineering Team",
  description:
    "Assemble a team of AI agents that contribute to your GitHub repo — writing code, reviewing PRs, and shipping features. Run locally on Docker. They never sleep.",
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
