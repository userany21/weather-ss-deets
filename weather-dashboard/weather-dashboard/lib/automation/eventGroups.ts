import type { Fill } from "./fillTypes";

export interface EventGroup {
  key: string;
  city: string;
  localDate: string;
  fills: Fill[];
  brackets: string[];
  spentUsd: number;
  wins: number;
  losses: number;
  open: number;
  settledPnl: number | null;
  lastFiredAt: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const time = (iso: string) => Date.parse(iso);

export function eventKey(fill: Pick<Fill, "city" | "local_date">): string {
  return `${fill.city.toLowerCase()}|${fill.local_date}`;
}

function buildGroup(key: string, list: Fill[]): EventGroup {
  const fills = [...list].sort((a, b) => time(b.fired_at) - time(a.fired_at));
  const settled = fills.filter((f) => f.pnl_usd !== null);
  return {
    key,
    city: fills[0].city,
    localDate: fills[0].local_date,
    fills,
    brackets: Array.from(new Set(fills.map((f) => f.bracket))),
    spentUsd: round2(fills.reduce((sum, f) => sum + f.spent_usd, 0)),
    wins: fills.filter((f) => f.won === true).length,
    losses: fills.filter((f) => f.won === false).length,
    open: fills.filter((f) => f.won === null).length,
    settledPnl: settled.length === 0 ? null : round2(settled.reduce((sum, f) => sum + (f.pnl_usd ?? 0), 0)),
    lastFiredAt: fills[0].fired_at,
  };
}

export function groupFillsByEvent(fills: Fill[]): EventGroup[] {
  const byKey = new Map<string, Fill[]>();
  for (const fill of fills) {
    const key = eventKey(fill);
    const list = byKey.get(key);
    if (list) list.push(fill);
    else byKey.set(key, [fill]);
  }
  return Array.from(byKey.entries())
    .map(([key, list]) => buildGroup(key, list))
    .sort((a, b) => time(b.lastFiredAt) - time(a.lastFiredAt));
}

export function dropOldestEvent(fills: Fill[]): Fill[] {
  if (fills.length === 0) return fills;
  let oldest = fills[0];
  for (const fill of fills) {
    if (time(fill.fired_at) < time(oldest.fired_at)) oldest = fill;
  }
  const key = eventKey(oldest);
  return fills.filter((fill) => eventKey(fill) !== key);
}
