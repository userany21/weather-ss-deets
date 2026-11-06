"use client";

import { useState } from "react";

/**
 * Small "Auto-buy" button for one pinned chip on /stats.
 * It saves the row as an auto-buy rule that is switched OFF.
 * Switch it on at /admin/automation.
 *
 * Use it inside the chip in app/stats/page.tsx (c is the pinned chip):
 *   <ArmButton label={c.label} criteriaKey={c.key} by={dimsToByParam(c.dims)} method={c.method}
 *              cities={selectedCities} dims={c.dims} />
 */
export interface ArmButtonProps {
  label: string;
  criteriaKey: string;
  by: string;
  method: string;
  cities: string[];
  dims?: unknown;
}

type Phase = "idle" | "saving" | "saved" | "exists" | "error";

export default function ArmButton(props: ArmButtonProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");

  async function arm() {
    setPhase("saving");
    setMessage("");
    try {
      const res = await fetch("/api/automation/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: props.label,
          criteriaKey: props.criteriaKey,
          by: props.by,
          method: props.method || "combined",
          cities: props.cities,
          dims: props.dims,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { created?: boolean; error?: string };
      if (!res.ok) {
        setPhase("error");
        setMessage(json.error ?? `Failed (${res.status})`);
        return;
      }
      setPhase(json.created ? "saved" : "exists");
    } catch {
      setPhase("error");
      setMessage("Open /admin/automation and sign in first");
    }
  }

  if (phase === "saved" || phase === "exists") {
    return (
      <a
        href="/admin/automation"
        title="Open the Auto-buy page to switch this row on"
        className="rounded border border-[#22c98a]/40 px-1.5 py-0.5 text-[10px] text-[#22d38a] hover:bg-[#22c98a]/10"
      >
        {phase === "saved" ? "Saved. Switch on" : "Already saved"}
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={arm}
        disabled={phase === "saving"}
        title="Save this row for auto-buy (it starts switched off)"
        className="rounded border border-[#38a3f5]/40 px-1.5 py-0.5 text-[10px] text-[#38a3f5] hover:bg-[#38a3f5]/10 disabled:opacity-60"
      >
        {phase === "saving" ? "Saving…" : "Auto-buy"}
      </button>
      {phase === "error" ? <span className="text-[10px] text-rose-400">{message}</span> : null}
    </>
  );
}
