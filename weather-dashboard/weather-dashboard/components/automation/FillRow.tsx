import type { Fill } from "../../lib/automation/fillTypes";
import { cents, usd } from "../../lib/automation/format";
import { pnlTone } from "./pnlTone";

interface FillRowProps {
  fill: Fill;
  variant: "flat" | "child";
}

export function FillRow({ fill: f, variant }: FillRowProps) {
  const child = variant === "child";
  return (
    <tr className={`border-t border-white/5 ${child ? "bg-white/[0.03]" : ""}`}>
      <td className="w-6 py-2" />
      <td className={`py-2 pr-3 text-[#a9b6d0] ${child ? "pl-3" : ""}`}>{new Date(f.fired_at).toLocaleString()}</td>
      <td className="py-2 pr-3 capitalize text-white">{f.city}</td>
      <td className="py-2 pr-3 tabular-nums text-[#a9b6d0]">{f.local_date}</td>
      <td className="py-2 pr-3 text-white">{f.bracket}</td>
      <td className="py-2 pr-3 text-[#a9b6d0]">{f.rule_label}</td>
      <td className="py-2 text-right tabular-nums text-[#a9b6d0]">
        {f.signal_price_cents === null ? "n/a" : `${f.signal_price_cents.toFixed(1)}¢`}
      </td>
      <td className="py-2 text-right tabular-nums">{cents(f.avg_price)}</td>
      <td className="py-2 text-right tabular-nums">{usd(f.spent_usd)}</td>
      <td className="py-2 text-right">
        {f.won === null ? (
          <span className="text-[#8e9bb8]">Open</span>
        ) : f.won ? (
          <span className="text-emerald-300">Won</span>
        ) : (
          <span className="text-rose-300">Lost</span>
        )}
      </td>
      <td className={`py-2 text-right tabular-nums ${pnlTone(f.pnl_usd)}`}>{f.pnl_usd === null ? "" : usd(f.pnl_usd)}</td>
    </tr>
  );
}
