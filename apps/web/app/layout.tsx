import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Gateway Console",
  description: "Operational console for the agent gateway.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

