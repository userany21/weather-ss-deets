import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Weather Dashboard",
  description: "Temp + market price curves by region / city / date",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-text min-h-screen">
        <header className="border-b border-border px-6 py-4 flex items-center gap-6">
          <Link href="/" className="font-semibold">
            Weather Dashboard
          </Link>
          <Link href="/live" className="text-live text-sm font-medium">
            ● Live now
          </Link>
        </header>
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
