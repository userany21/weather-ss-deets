import {
  CITY_SCHEDULE,
  classifyBy,
  gate,
  outcomeWon,
  parseBy,
  planBuys,
  pnlFor,
  type RuleClass,
} from "./engine";
import { evaluateRule, type BridgeMatch } from "./liveBridge";
import { loadTodayTicks, loadWinningBracket, type TickDoc, type TickMethod } from "./mongo";
import { sendBuy, type BuyIntent, type BuyReply } from "./polybot";
import {
  fillExists,
  insertFill,
  listEnabledRules,
  listOpenFills,
  settleFill,
  type NewFill,
  type RuleRow,
} from "./store";

/**
 * One pass of the auto-buy worker. POST /api/automation/tick calls this once a minute from cron.
 *
 * Per enabled rule and city:
 *   1. engine.gate decides if the rule's closing tick (or first tick) is stored and fresh.
 *   2. liveBridge.evaluateRule says which brackets match.
 *   3. For each bracket: skip if a fill row already exists, else send ONE signed request to PolyBot.
 *   4. Only a reply of status "filled" is stored. Rejects, timeouts and misses write nothing.
 * Then fills whose city-day has a winning bracket are marked won or lost with P&L.
 */

const MAX_SIGNAL_AGE_MIN = envNum("AUTOMATION_MAX_SIGNAL_AGE_MIN", 12);
const CLOSE_GRACE_MIN = envNum("AUTOMATION_CLOSE_GRACE_MIN", 20);
const MAX_BUYS_PER_RULE_CITY_DAY = envNum("AUTOMATION_MAX_BUYS_PER_RULE_CITY_DAY", 3);
const INTENT_TTL_MS = 60_000;
const SETTLE_EVERY_MS = 5 * 60_000;
const ATTEMPT_MEMORY_MS = 36 * 3_600_000;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

interface State {
  running: boolean;
  /** key -> epoch ms. A key is attempted once per process lifetime (36h). PolyBot dedupes across restarts. */
  attempted: Map<string, number>;
  /** Fills PolyBot confirmed but Supabase refused. Retried every pass. Lost on restart, so also logged. */
  outbox: NewFill[];
  lastSettleMs: number;
}

const g = globalThis as unknown as { __wxAuto?: State };

function state(): State {
  if (!g.__wxAuto) g.__wxAuto = { running: false, attempted: new Map(), outbox: [], lastSettleMs: 0 };
  return g.__wxAuto;
}

export interface TickSummary {
  ranAt: string;
  rules: number;
  evaluated: number;
  bought: number;
  settled: number;
  skipped: Record<string, number>;
  errors: string[];
}

function bump(summary: TickSummary, key: string): void {
  summary.skipped[key] = (summary.skipped[key] ?? 0) + 1;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runTick(now: Date = new Date()): Promise<TickSummary> {
  const st = state();
  const summary: TickSummary = {
    ranAt: now.toISOString(),
    rules: 0,
    evaluated: 0,
    bought: 0,
    settled: 0,
    skipped: {},
    errors: [],
  };
  if (st.running) {
    bump(summary, "busy");
    return summary;
  }
  st.running = true;
  try {
    await flushOutbox(st, summary);

    const rules = await listEnabledRules();
    summary.rules = rules.length;
    const tickCache = new Map<string, TickDoc[]>();
    for (const rule of rules) {
      try {
        await processRule(rule, now, st, tickCache, summary);
      } catch (e) {
        summary.errors.push(`rule ${rule.id}: ${errMsg(e)}`);
      }
    }

    await settleDue(st, now, summary);
  } catch (e) {
    summary.errors.push(errMsg(e));
  } finally {
    purgeAttempts(st, now.getTime());
    st.running = false;
  }
  if (summary.errors.length > 0) console.error("[automation] tick errors", summary.errors);
  return summary;
}

async function processRule(
  rule: RuleRow,
  now: Date,
  st: State,
  tickCache: Map<string, TickDoc[]>,
  summary: TickSummary,
): Promise<void> {
  let cls: RuleClass;
  try {
    cls = classifyBy(parseBy(rule.by_param));
  } catch (e) {
    bump(summary, "bad_rule");
    summary.errors.push(`rule ${rule.id} has an invalid by_param: ${errMsg(e)}`);
    return;
  }
  if (cls.kind === "never") {
    bump(summary, "rule_not_tradeable");
    return;
  }

  const cities = rule.cities.length > 0 ? rule.cities : Object.keys(CITY_SCHEDULE);
  const method = rule.method as TickMethod;

  for (const city of cities) {
    const gateOpts = { maxSignalAgeMin: MAX_SIGNAL_AGE_MIN, closeGraceMin: CLOSE_GRACE_MIN };

    // Cheap pre-check with no database read: is the window open at all?
    const pre = gate({ cls, city, now, ticks: [], ...gateOpts });
    if (pre.state !== "missing") continue;
    const localDate = pre.localDate;

    const evalKey = `eval|${rule.id}|${city}|${localDate}`;
    if (st.attempted.has(evalKey)) continue;

    const cacheKey = `${city}|${localDate}|${method}`;
    let ticks = tickCache.get(cacheKey);
    if (!ticks) {
      ticks = await loadTodayTicks(city, localDate, method);
      tickCache.set(cacheKey, ticks);
    }

    const g2 = gate({ cls, city, now, ticks, ...gateOpts });
    if (g2.state === "missing") {
      const missKey = `miss|${evalKey}`;
      if (!st.attempted.has(missKey)) {
        st.attempted.set(missKey, now.getTime());
        console.warn(`[automation] closing tick missing for ${city} ${localDate} (rule ${rule.id})`);
      }
      bump(summary, "closing_tick_missing");
      continue;
    }
    if (g2.state === "stale") {
      st.attempted.set(evalKey, now.getTime());
      bump(summary, "signal_stale");
      continue;
    }
    if (g2.state !== "ready") continue;

    let matches: BridgeMatch[];
    try {
      matches = await evaluateRule({ by: rule.by_param, criteriaKey: rule.criteria_key, method: rule.method, city, localDate });
    } catch (e) {
      summary.errors.push(`evaluate ${rule.id}/${city}: ${errMsg(e)}`);
      continue; // not marked attempted: retried next pass while the window is open
    }
    st.attempted.set(evalKey, now.getTime());
    summary.evaluated += 1;

    const plan = planBuys({
      ruleId: rule.id,
      city,
      localDate,
      label: g2.label,
      matches,
      tickDocs: ticks,
      maxBuys: MAX_BUYS_PER_RULE_CITY_DAY,
    });
    if (plan.buys.length === 0) {
      bump(summary, plan.reason ?? "no_match");
      if (plan.reason === "too_broad") {
        console.warn(`[automation] rule ${rule.id} matched ${plan.count} brackets in ${city}; skipped (cap ${MAX_BUYS_PER_RULE_CITY_DAY})`);
      }
      continue;
    }

    for (const buy of plan.buys) {
      if (st.attempted.has(buy.intentId)) continue;

      let exists: boolean;
      try {
        exists = await fillExists(rule.id, city, localDate, buy.bracket);
      } catch (e) {
        summary.errors.push(`fillExists ${rule.id}: ${errMsg(e)}`);
        bump(summary, "store_unavailable");
        continue; // cannot prove it is new, so do not buy
      }
      if (exists) {
        bump(summary, "already_filled");
        continue;
      }

      st.attempted.set(buy.intentId, now.getTime());

      const intent: BuyIntent = {
        v: 1,
        intentId: buy.intentId,
        ruleId: rule.id,
        ruleLabel: rule.label,
        city,
        localDate,
        bracket: buy.bracket,
        stakeUsd: Number(rule.stake_usd),
        maxPriceCents: rule.max_price_cents,
        signalPriceCents: buy.signalPriceCents,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
      };

      const reply = await sendBuy(intent);
      if (!reply) {
        bump(summary, "no_reply");
        console.warn(`[automation] no reply from PolyBot for ${buy.intentId} (${city} ${buy.bracket}); nothing stored`);
        continue;
      }
      if (reply.status !== "filled") {
        bump(summary, `rejected_${reply.reason ?? reply.status}`);
        continue;
      }

      const fill = toFill(rule, intent, reply, buy.method, g2.label, g2.capturedAt);
      if (!fill) {
        bump(summary, "bad_fill_reply");
        console.error("[automation] PolyBot said filled but the reply was unusable", JSON.stringify({ intent, reply }));
        continue;
      }
      summary.bought += 1;
      await storeFill(fill, st);
    }
  }
}

function toFill(
  rule: RuleRow,
  intent: BuyIntent,
  reply: BuyReply,
  method: string | null,
  signalLabel: string,
  signalCapturedAt: number,
): NewFill | null {
  const avgPrice = Number(reply.avgPrice);
  const shares = Number(reply.shares);
  const spentUsd = Number(reply.spentUsd);
  if (![avgPrice, shares, spentUsd].every((n) => Number.isFinite(n) && n > 0)) return null;
  return {
    rule_id: rule.id,
    rule_label: rule.label,
    criteria_key: rule.criteria_key,
    method,
    city: intent.city,
    local_date: intent.localDate,
    bracket: intent.bracket,
    token_id: reply.tokenId ?? null,
    intent_id: intent.intentId,
    signal_price_cents: intent.signalPriceCents,
    signal_pacing_time: signalLabel,
    signal_tick_at: new Date(signalCapturedAt).toISOString(),
    stake_usd: intent.stakeUsd,
    avg_price: avgPrice,
    shares,
    spent_usd: spentUsd,
    order_id: reply.orderId ?? null,
  };
}

async function storeFill(fill: NewFill, st: State): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await insertFill(fill);
      console.log(`[automation] FILLED ${fill.city} ${fill.local_date} ${fill.bracket} $${fill.spent_usd} @ ${fill.avg_price}`);
      return;
    } catch (e) {
      if (attempt === 3) {
        st.outbox.push(fill);
        console.error("[automation] FILL-NOT-STORED (queued for retry, record it by hand if the process restarts)", JSON.stringify(fill), errMsg(e));
        return;
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

async function flushOutbox(st: State, summary: TickSummary): Promise<void> {
  if (st.outbox.length === 0) return;
  const pending = st.outbox.splice(0, st.outbox.length);
  for (const fill of pending) {
    try {
      await insertFill(fill);
    } catch (e) {
      st.outbox.push(fill);
      summary.errors.push(`outbox retry failed: ${errMsg(e)}`);
    }
  }
}

async function settleDue(st: State, now: Date, summary: TickSummary): Promise<void> {
  if (now.getTime() - st.lastSettleMs < SETTLE_EVERY_MS) return;
  st.lastSettleMs = now.getTime();

  const open = await listOpenFills();
  const days = new Map<string, typeof open>();
  for (const f of open) {
    const k = `${f.city}|${f.local_date}`;
    const list = days.get(k);
    if (list) list.push(f);
    else days.set(k, [f]);
  }
  for (const [key, fills] of days) {
    const [city, localDate] = key.split("|");
    let winner: string | null;
    try {
      winner = await loadWinningBracket(city, localDate);
    } catch (e) {
      summary.errors.push(`winner lookup ${key}: ${errMsg(e)}`);
      continue;
    }
    if (!winner) continue;
    for (const f of fills) {
      const won = outcomeWon(f.bracket, winner);
      try {
        await settleFill(f.id, {
          winning_bracket: winner,
          won,
          pnl_usd: pnlFor({ shares: Number(f.shares), spentUsd: Number(f.spent_usd), won }),
          settled_at: new Date().toISOString(),
        });
        summary.settled += 1;
      } catch (e) {
        summary.errors.push(`settle ${f.id}: ${errMsg(e)}`);
      }
    }
  }
}

function purgeAttempts(st: State, nowMs: number): void {
  for (const [k, t] of st.attempted) {
    if (nowMs - t > ATTEMPT_MEMORY_MS) st.attempted.delete(k);
  }
}
