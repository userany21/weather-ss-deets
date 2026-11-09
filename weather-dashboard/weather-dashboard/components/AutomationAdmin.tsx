"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import type { Fill, RuleStats } from "../lib/automation/fillTypes";
import { usd } from "../lib/automation/format";
import { BuyHistory } from "./automation/BuyHistory";

const FILLS_LIMIT = 500;

interface Rule {
  id: string;
  label: string;
  criteria_key: string;
  by_param: string;
  method: string;
  cities: string[];
  enabled: boolean;
  stake_usd: number;
  max_price_cents: number | null;
  stats: RuleStats;
}
interface RulesResp {
  automationEnabled: boolean;
  rules: Rule[];
}
interface FillsResp {
  fills: Fill[];
  summary: RuleStats;
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function fetcher<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    throw new ApiError(0, "Blocked. Sign in through Cloudflare Access, then reload.");
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`);
  return json;
}

function Switch(props: { on: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#38a3f5] ${
        props.on ? "bg-emerald-500" : "bg-[#2a3552]"
      } ${props.disabled ? "opacity-50" : ""}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${props.on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

function NumField(props: {
  value: number | null;
  placeholder?: string;
  min: number;
  max: number;
  step?: number;
  label: string;
  onCommit: (next: number | null) => void;
}) {
  const [text, setText] = useState(props.value === null ? "" : String(props.value));
  return (
    <input
      aria-label={props.label}
      inputMode="decimal"
      value={text}
      placeholder={props.placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const trimmed = text.trim();
        if (trimmed === "") {
          if (props.value !== null) props.onCommit(null);
          return;
        }
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n < props.min || n > props.max) {
          setText(props.value === null ? "" : String(props.value));
          return;
        }
        if (n !== props.value) props.onCommit(n);
      }}
      className="w-16 rounded-md border border-white/10 bg-[#0b1222] px-2 py-1 text-right text-sm text-white outline-none focus:border-[#38a3f5]"
    />
  );
}

export default function AutomationAdmin() {
  const rules = useSWR<RulesResp, ApiError>("/api/automation/rules", fetcher, { refreshInterval: 15000 });
  const fills = useSWR<FillsResp, ApiError>(`/api/automation/fills?limit=${FILLS_LIMIT}`, fetcher, { refreshInterval: 30000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusyId(id);
      setError(null);
      try {
        const res = await fetch(`/api/automation/rules/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) setError(json.error ?? `Update failed (${res.status})`);
        await rules.mutate();
      } catch {
        setError("Update failed. Check your connection and sign-in.");
      } finally {
        setBusyId(null);
      }
    },
    [rules],
  );

  const remove = useCallback(
    async (rule: Rule) => {
      if (!window.confirm(`Remove "${rule.label}"? Its past buys stay in the buy history.`)) return;
      setBusyId(rule.id);
      setError(null);
      try {
        const res = await fetch(`/api/automation/rules/${rule.id}`, { method: "DELETE" });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          setError(json.error ?? `Remove failed (${res.status})`);
        }
        await rules.mutate();
      } finally {
        setBusyId(null);
      }
    },
    [rules],
  );

  const authProblem = [rules.error, fills.error].find((e) => e && (e.status === 0 || e.status === 401 || e.status === 403 || e.status === 503));

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 text-[#d5def0]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">Auto-buy</h1>
          <p className="mt-1 max-w-xl text-sm text-[#8e9bb8]">
            Each saved row buys on its own. The order goes out on the last tick of the hour before the label, for example
            the last 11 AM tick for “before 12 PM”.
          </p>
        </div>
        {rules.data ? (
          <span
            className={`rounded-md px-2.5 py-1 text-xs ${
              rules.data.automationEnabled ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"
            }`}
          >
            {rules.data.automationEnabled ? "Worker is on" : "Worker is off on the server"}
          </span>
        ) : null}
      </header>

      {authProblem ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{authProblem.message}</div>
      ) : null}
      {error ? <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</div> : null}

      <section className="overflow-x-auto rounded-xl border border-white/5 bg-[#0f1729] p-5">
        <h2 className="mb-3 text-[15px] font-semibold text-white">Saved rows</h2>
        {rules.isLoading ? (
          <p className="text-sm text-[#8e9bb8]">Loading…</p>
        ) : rules.data && rules.data.rules.length === 0 ? (
          <p className="text-sm text-[#8e9bb8]">
            Nothing saved yet. Pin a row on the Stats page, then choose “Save for auto-buy”.
          </p>
        ) : (
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-[#6f7c99]">
                <th className="pb-2 font-normal">Row</th>
                <th className="pb-2 font-normal">Cities</th>
                <th className="pb-2 text-right font-normal">Stake</th>
                <th className="pb-2 text-right font-normal">Max price (¢)</th>
                <th className="pb-2 text-right font-normal">Buys</th>
                <th className="pb-2 text-right font-normal">Won / lost</th>
                <th className="pb-2 text-right font-normal">P&amp;L</th>
                <th className="pb-2 text-right font-normal">On</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rules.data?.rules.map((r) => (
                <tr key={r.id} className="border-t border-white/5 align-middle">
                  <td className="py-2.5 pr-3">
                    <div className="text-white">{r.label}</div>
                    <div className="font-mono text-[11px] text-[#6f7c99]">
                      {r.criteria_key} · {r.method}
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-[#a9b6d0]">
                    {r.cities.length === 0 ? "All cities" : r.cities.length <= 3 ? r.cities.join(", ") : `${r.cities.length} cities`}
                  </td>
                  <td className="py-2.5 text-right">
                    <NumField label="Stake in dollars" value={r.stake_usd} min={1} max={5} onCommit={(n) => n !== null && patch(r.id, { stakeUsd: n })} />
                  </td>
                  <td className="py-2.5 text-right">
                    <NumField
                      label="Max price in cents"
                      value={r.max_price_cents}
                      placeholder="none"
                      min={1}
                      max={99}
                      onCommit={(n) => patch(r.id, { maxPriceCents: n })}
                    />
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{r.stats.fills}</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {r.stats.wins} / {r.stats.losses}
                    {r.stats.open > 0 ? <span className="text-[#6f7c99]"> ({r.stats.open} open)</span> : null}
                  </td>
                  <td className={`py-2.5 text-right tabular-nums ${r.stats.pnl > 0 ? "text-emerald-300" : r.stats.pnl < 0 ? "text-rose-300" : ""}`}>
                    {usd(r.stats.pnl)}
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="flex justify-end">
                      <Switch on={r.enabled} disabled={busyId === r.id} label={`Auto-buy for ${r.label}`} onChange={(next) => patch(r.id, { enabled: next })} />
                    </div>
                  </td>
                  <td className="py-2.5 pl-3 text-right">
                    <button type="button" onClick={() => remove(r)} disabled={busyId === r.id} className="text-xs text-[#6f7c99] underline underline-offset-2 hover:text-rose-300">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <BuyHistory fills={fills.data?.fills} summary={fills.data?.summary} limit={FILLS_LIMIT} />
    </main>
  );
}
