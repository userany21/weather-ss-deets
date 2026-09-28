import "./globals.css";
import type { Metadata } from "next";
import TopNav from "@/components/TopNav";

export const metadata: Metadata = {
  title: "Weather Dashboard",
  description: "Temp + market price curves by region / city / date",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-text min-h-screen">
        <TopNav />
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
