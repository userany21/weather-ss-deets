"use client";

import { useEffect, useState, useMemo } from "react";
import { CITIES } from "@/lib/cities-config";

type Region = "america" | "asia" | "europe";

const LABELS: Record<Region, string> = {
  america: "Americas",
  asia: "Asia",
  europe: "Europe",
};

// ─── time helpers ────────────────────────────────────────────────────────────

function getCityHour(tz: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

function fmtLocalTime(tz: string, now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

function isCityActive(tz: string, now: Date): boolean {
  const h = getCityHour(tz, now);
  return h >= 8 && h < 18;
}

// ─── region scoring ───────────────────────────────────────────────────────────
//
//  Nowcast window = 8am–6pm local.
//
//  Active (8–18):  score = avgHour  → later in the day = higher urgency → #1
//  Done   (≥18):   score = avgHour – 24  (negative; region closed for the day)
//  Upcoming (<8):  score = avgHour – 8   (negative; not yet open; closer to 0
//                                          means almost at 8am → more relevant)
//
//  A region is considered "done" only when ALL its cities have passed 6pm
//  (mirrors the user rule: "as soon as all Asian cities go past 6pm").

function regionScore(region: Region, now: Date): number {
  const cs = CITIES.filter((c) => c.region === region);
  const hours = cs.map((c) => getCityHour(c.timezone, now));
  const avg = hours.reduce((a, b) => a + b, 0) / hours.length;

  const allDone = hours.every((h) => h >= 18);
  const allUpcoming = hours.every((h) => h < 8);

  if (allDone) return avg - 24;   // closed — lowest priority
  if (allUpcoming) return avg - 8; // not yet open — mid-low priority
  return avg;                      // at least partially active — highest priority
}

function getOrderedRegions(now: Date): Region[] {
  return (["america", "asia", "europe"] as Region[]).sort(
    (a, b) => regionScore(b, now) - regionScore(a, now),
  );
}

// ─── fixed layout constant ────────────────────────────────────────────────────
// Asia has 7 cities (largest section); Americas + Europe have 6 each.
// At 10.5 px text + 2 px gap, 7 rows ≈ 103 px; add header + padding → 140 px.
const SECTION_H = 140; // px

// ─── component ────────────────────────────────────────────────────────────────

export default function CityClockWidget() {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    // Tick once immediately, then align to minute boundaries.
    const delay = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 60_000);
    }, delay);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, []);

  // Re-rank whenever the clock ticks (cheap calculation).
  const ranked = useMemo(() => getOrderedRegions(now), [now]);

  // Duplicate the 3 sections so the CSS infinite-scroll is seamless:
  //   visible window = 3 × SECTION_H
  //   inner div      = 6 × SECTION_H
  //   animation moves inner div up by exactly -50% (= 3 sections) and loops.
  const looped: Region[] = [...ranked, ...ranked];

  // Changing the key resets the CSS animation whenever ranking order changes,
  // so the newly top-ranked region snaps back to position 1.
  const animKey = ranked.join(",");

  return (
    <div
      className="fixed right-4 z-50 w-52 rounded-xl border border-border bg-panel/95 backdrop-blur-sm shadow-2xl overflow-hidden select-none"
      style={{ top: "72px", height: SECTION_H * 3 }}
      aria-label="City local-time clock"
    >
      {/* Scrolling track */}
      <div
        key={animKey}
        className="city-clock-track"
        style={{ height: SECTION_H * 6 }}
      >
        {looped.map((region, i) => (
          <RegionSection
            key={`${region}-${i}`}
            region={region}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}

// ─── single region panel ──────────────────────────────────────────────────────

function RegionSection({ region, now }: { region: Region; now: Date }) {
  const cities = CITIES.filter((c) => c.region === region);

  return (
    <div
      style={{ height: SECTION_H }}
      className="px-3 pt-2 border-b border-border/50"
    >
      {/* Region header */}
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-subtext/70 mb-1.5 pb-1 border-b border-border/30">
        {LABELS[region]}
      </p>

      {/* City rows */}
      <div className="space-y-[2px]">
        {cities.map((c) => {
          const active = isCityActive(c.timezone, now);
          const time = fmtLocalTime(c.timezone, now);
          return (
            <div
              key={c.city}
              className="flex items-center justify-between gap-1"
            >
              <span
                className={`text-[10.5px] capitalize leading-none transition-colors duration-500 ${
                  active ? "text-text" : "text-subtext/40"
                }`}
              >
                {c.city}
              </span>
              <span
                className={`text-[10.5px] font-mono tabular-nums leading-none shrink-0 transition-colors duration-500 ${
                  active ? "text-live" : "text-subtext/35"
                }`}
              >
                {time}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
