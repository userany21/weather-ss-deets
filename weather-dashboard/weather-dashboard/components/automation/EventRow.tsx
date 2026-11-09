import type { EventGroup } from "../../lib/automation/eventGroups";
import { usd } from "../../lib/automation/format";
import { FillRow } from "./FillRow";
import { pnlTone } from "./pnlTone";

interface EventRowProps {
  group: EventGroup;
  open: boolean;
  onToggle: (key: string) => void;
}

function ResultSummary({ group: g }: { group: EventGroup }) {
  const parts: { text: string; tone: string }[] = [];
  if (g.wins > 0) parts.push({ text: `${g.wins} won`, tone: "text-emerald-300" });
  if (g.losses > 0) parts.push({ text: `${g.losses} lost`, tone: "text-rose-300" });
  if (g.open > 0) parts.push({ text: `${g.open} open`, tone: "text-[#8e9bb8]" });
  return (
    <>
      {parts.map((p, i) => (
        <span key={p.text}>
          {i > 0 ? <span className="text-[#6f7c99]"> · </span> : null}
          <span className={p.tone}>{p.text}</span>
        </span>
      ))}
    </>
  );
}

export function EventRow({ group: g, open, onToggle }: EventRowProps) {
  const pnlNote = g.open > 0 && g.settledPnl !== null ? `Settled buys only. ${g.open} still open.` : undefined;
  return (
    <>
      <tr onClick={() => onToggle(g.key)} className="cursor-pointer border-t border-white/5 hover:bg-white/[0.02]">
        <td className="w-6 py-2 pl-1">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} buys for ${g.city} on ${g.localDate}`}
            className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[#38a3f5]"
          >
            <span className={`inline-block text-[#8e9bb8] transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
          </button>
        </td>
        <td className="py-2 pr-3 text-[#a9b6d0]">{new Date(g.lastFiredAt).toLocaleString()}</td>
        <td className="py-2 pr-3 capitalize text-white">{g.city}</td>
        <td className="py-2 pr-3 tabular-nums text-[#a9b6d0]">{g.localDate}</td>
        <td className="py-2 pr-3 text-white">{g.brackets.length === 1 ? g.brackets[0] : `${g.brackets.length} brackets`}</td>
        <td className="py-2 pr-3 text-[#a9b6d0]">{g.fills.length} buys</td>
        <td className="py-2" />
        <td className="py-2" />
        <td className="py-2 text-right tabular-nums">{usd(g.spentUsd)}</td>
        <td className="py-2 text-right">
          <ResultSummary group={g} />
        </td>
        <td
          title={pnlNote}
          className={`py-2 text-right tabular-nums ${g.open > 0 ? "text-[#8e9bb8]" : pnlTone(g.settledPnl)}`}
        >
          {g.settledPnl === null ? "" : usd(g.settledPnl)}
        </td>
      </tr>
      {open ? g.fills.map((f) => <FillRow key={f.id} fill={f} variant="child" />) : null}
    </>
  );
}
