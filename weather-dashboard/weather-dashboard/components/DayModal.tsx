"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import useSWR from "swr";
import TempChart from "@/components/TempChart";
import { getCityConfig } from "@/lib/cities-config";
import type { EnrichedTick } from "@/lib/weather-transform";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface DayResponse {
  city: string;
  date: string;
  unit: "F" | "C";
  winningLow: number | null;
  winningHigh: number | null;
  winningBracket: string | null;
  ticks: EnrichedTick[];
  reciprocalTicks: EnrichedTick[];
}

export default function DayModal({
  city,
  date,
  onClose,
  header,
}: {
  city: string;
  date: string;
  onClose: () => void;
  header?: ReactNode;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const { data, error, isLoading } = useSWR<DayResponse>(
    `/api/day/${encodeURIComponent(city)}/${date}`,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 0 }
  );

  const region = getCityConfig(city)?.region;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => onCloseRef.current()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${city} ${date}`}
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-[#16233a] bg-[#070f1c] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-semibold capitalize text-white">{city}</div>
            <div className="text-sm tabular-nums text-[#8a97b1]">{date}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onCloseRef.current()}
            className="px-1 text-lg leading-none text-[#8a97b1] hover:text-white"
          >
            ×
          </button>
        </div>

        {header && <div className="mt-3">{header}</div>}

        <div className="mt-4">
          {isLoading ? (
            <div className="text-sm text-[#8a97b1]">Loading…</div>
          ) : error ? (
            <div className="text-sm text-[#ff5566]">Could not load day data.</div>
          ) : data && data.ticks.length === 0 ? (
            <div className="text-sm text-[#8a97b1]">No ticks recorded for this city/date.</div>
          ) : data ? (
            <TempChart
              ticks={data.ticks}
              reciprocalTicks={data.reciprocalTicks ?? []}
              unit={data.unit}
              city={city}
              winningLow={data.winningLow}
              winningHigh={data.winningHigh}
              winningBracket={data.winningBracket}
            />
          ) : null}
        </div>

        {region && (
          <div className="mt-4">
            <Link
              href={`/${region}/${encodeURIComponent(city)}/${date}`}
              className="inline-flex items-center rounded-full border border-[#38a3f5]/50 px-4 py-1.5 text-xs text-[#38a3f5] hover:bg-[#38a3f5]/10"
            >
              Open full day page
            </Link>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
