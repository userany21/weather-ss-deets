"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Card from "@/components/Card";
import { ChevronIcon, ClockIcon } from "@/components/icons";
import { CITIES } from "@/lib/cities-config";
import { C } from "@/lib/theme";

type Region = "america" | "europe" | "asia";

const SECTIONS: { region: Region; label: string }[] = [
  { region: "america", label: "Americas" },
  { region: "europe", label: "Europe" },
  { region: "asia", label: "Asia" },
];

function getCityHour(tz: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
}

function fmtLocalTime(tz: string, now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

// Nowcast window = 8am–6pm local.
function isCityActive(tz: string, now: Date): boolean {
  const h = getCityHour(tz, now);
  return h >= 8 && h < 18;
}

export default function LocalTimesPanel() {
  // null until mounted so server and client markup match
  const [now, setNow] = useState<Date | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  // City currently being viewed: /[region]/[city]/[date]
  const pathname = usePathname() ?? "";
  const viewed = decodeURIComponent(pathname.split("/")[2] ?? "").toLowerCase();

  useEffect(() => {
    setNow(new Date());
    // Align to minute boundaries after the first tick.
    const delay = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 60_000);
    }, delay);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  return (
    <Card className="self-start overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[#151c2b] px-5 py-4">
        <ClockIcon width={22} height={22} className="text-[#8b92a0]" />
        <h2 className="text-base font-semibold text-white">Local Times</h2>
      </div>

      {SECTIONS.map(({ region, label }, i) => {
        const isClosed = !!closed[region];
        const cities = CITIES.filter((c) => c.region === region);
        return (
          <section key={region} className={i > 0 ? "border-t border-[#151c2b]" : ""}>
            <button
              type="button"
              onClick={() => setClosed((s) => ({ ...s, [region]: !s[region] }))}
              aria-expanded={!isClosed}
              className="flex w-full items-center justify-between px-5 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8b92a0]"
            >
              {label}
              <ChevronIcon dir={isClosed ? "down" : "up"} width={16} height={16} />
            </button>

            {!isClosed && (
              <ul className="space-y-2.5 px-5 pb-4 pt-1">
                {cities.map((c) => {
                  const isViewed = c.city.toLowerCase() === viewed;
                  const active = now ? isCityActive(c.timezone, now) : false;
                  return (
                    <li key={c.city} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2.5">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#8b92a0]" />
                        <span
                          className={`text-[13px] capitalize ${
                            isViewed ? "font-medium text-white" : "text-[#b4bccb]"
                          }`}
                        >
                          {c.city}
                        </span>
                      </span>
                      <span
                        className="font-mono text-[13px] tabular-nums"
                        style={{ color: active ? C.amber : C.sub }}
                      >
                        {now ? fmtLocalTime(c.timezone, now) : "--:--"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </Card>
  );
}
