"use client";

import { useMemo, useState } from "react";
import { dropOldestEvent, groupFillsByEvent } from "../../lib/automation/eventGroups";
import type { Fill, RuleStats } from "../../lib/automation/fillTypes";
import { usd } from "../../lib/automation/format";
import { EventRow } from "./EventRow";
import { FillRow } from "./FillRow";

interface BuyHistoryProps {
  fills: Fill[] | undefined;
  summary: RuleStats | undefined;
  limit: number;
}

export function BuyHistory({ fills, summary, limit }: BuyHistoryProps) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const truncated = fills !== undefined && fills.length >= limit;

  const groups = useMemo(() => {
    if (!fills) return [];
    return groupFillsByEvent(truncated ? dropOldestEvent(fills) : fills);
  }, [fills, truncated]);

  const toggle = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="overflow-x-auto rounded-xl border border-white/5 bg-[#0f1729] p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-white">Buy history</h2>
        {summary ? (
          <p className="text-sm text-[#8e9bb8]">
            {summary.fills} buys in {groups.length} events · {usd(summary.spent)} spent · {summary.wins} won,{" "}
            {summary.losses} lost, {summary.open} open ·{" "}
            <span className={summary.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{usd(summary.pnl)}</span> settled P&amp;L
          </p>
        ) : null}
      </div>
      {fills && fills.length === 0 ? (
        <p className="text-sm text-[#8e9bb8]">No buys yet. Only orders that filled are recorded here.</p>
      ) : (
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-[#6f7c99]">
              <th className="w-6 pb-2" />
              <th className="pb-2 font-normal">Bought</th>
              <th className="pb-2 font-normal">City</th>
              <th className="pb-2 font-normal">Day</th>
              <th className="pb-2 font-normal">Bracket</th>
              <th className="pb-2 font-normal">Row</th>
              <th className="pb-2 text-right font-normal">Signal</th>
              <th className="pb-2 text-right font-normal">Fill</th>
              <th className="pb-2 text-right font-normal">Spent</th>
              <th className="pb-2 text-right font-normal">Result</th>
              <th className="pb-2 text-right font-normal">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) =>
              g.fills.length === 1 ? (
                <FillRow key={g.key} fill={g.fills[0]} variant="flat" />
              ) : (
                <EventRow key={g.key} group={g} open={openKeys.has(g.key)} onToggle={toggle} />
              ),
            )}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-[#6f7c99]">
        Signal is the price on the closing tick. Fill is what PolyBot actually paid. The Stats page edge was measured from the
        first 12 PM tick, so compare real P&amp;L here, not that number.
        {truncated ? " Only the newest buys show. The oldest day is hidden because it can be incomplete." : ""}
      </p>
    </section>
  );
}
