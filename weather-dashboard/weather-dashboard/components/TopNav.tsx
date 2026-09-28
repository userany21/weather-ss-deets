"use client";

import Link from "next/link";
import { CloudIcon, LineChartIcon } from "@/components/icons";
import { C } from "@/lib/theme";

const STATS_HREF = "/stats";

export default function TopNav() {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <header className="flex items-center gap-4 border-b border-[#151c2b] px-6 py-4">
      <Link href="/" className="flex items-center gap-3">
        <CloudIcon width={34} height={34} fill="#4aa3ff" stroke="#4aa3ff" />
        <span className="text-lg font-semibold text-white">Weather Dashboard</span>
      </Link>

      <Link
        href="/live"
        className="ml-4 flex items-center gap-2.5 rounded-full bg-[#101725] px-4 py-2 text-sm text-[#e8ecf4]"
      >
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: C.green, boxShadow: `0 0 8px ${C.green}` }}
        />
        Live now
      </Link>

      <Link
        href={STATS_HREF}
        className="flex items-center gap-2 px-2 text-sm text-[#8b92a0] transition-colors hover:text-white"
      >
        <LineChartIcon width={18} height={18} />
        Stats Explorer
      </Link>

      <span className="ml-auto text-sm text-[#8b92a0]" suppressHydrationWarning>
        {today}
      </span>
    </header>
  );
}
