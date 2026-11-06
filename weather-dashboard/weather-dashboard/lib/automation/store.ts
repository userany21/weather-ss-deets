import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase access for rules and fills. Server-only: it uses the service-role key.
 * Placeholders to fill in .env.local: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Tables come from supabase/automation.sql.
 */

export type RuleMethod = "combined" | "linear" | "reciprocal" | "all";

export interface RuleRow {
  id: string;
  label: string;
  criteria_key: string;
  by_param: string;
  dims: unknown;
  method: RuleMethod;
  cities: string[];
  enabled: boolean;
  stake_usd: number;
  max_price_cents: number | null;
  created_at: string;
  updated_at: string;
}

export interface FillRow {
  id: string;
  rule_id: string | null;
  rule_label: string;
  criteria_key: string;
  method: string | null;
  city: string;
  local_date: string;
  bracket: string;
  token_id: string | null;
  intent_id: string;
  signal_price_cents: number | null;
  signal_pacing_time: string | null;
  signal_tick_at: string | null;
  stake_usd: number;
  avg_price: number;
  shares: number;
  spent_usd: number;
  order_id: string | null;
  fired_at: string;
  winning_bracket: string | null;
  won: boolean | null;
  pnl_usd: number | null;
  settled_at: string | null;
}

export type NewFill = Omit<
  FillRow,
  "id" | "fired_at" | "winning_bracket" | "won" | "pnl_usd" | "settled_at"
>;

export interface RuleStats {
  fills: number;
  wins: number;
  losses: number;
  open: number;
  pnl: number;
  spent: number;
}

let _client: SupabaseClient | null = null;

function sb(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Next.js caches server-side fetches by default. Never cache these.
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
  return _client;
}

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`supabase ${what}: ${error ? error.message : "unknown error"}`);
}

const UNIQUE_VIOLATION = "23505";

// ---- rules -------------------------------------------------------------------------------

export async function listRules(): Promise<RuleRow[]> {
  const { data, error } = await sb().from("automation_rules").select("*").order("created_at", { ascending: false });
  if (error) fail("listRules", error);
  return (data ?? []) as RuleRow[];
}

export async function listEnabledRules(): Promise<RuleRow[]> {
  const { data, error } = await sb().from("automation_rules").select("*").eq("enabled", true);
  if (error) fail("listEnabledRules", error);
  return (data ?? []) as RuleRow[];
}

export interface NewRule {
  label: string;
  criteria_key: string;
  by_param: string;
  dims: unknown;
  method: RuleMethod;
  cities: string[];
  stake_usd: number;
  max_price_cents: number | null;
}

/** Arms a pin once. The same criteria + method + cities returns the existing rule. */
export async function createRuleIfNew(input: NewRule): Promise<{ rule: RuleRow; created: boolean }> {
  const find = async (): Promise<RuleRow | null> => {
    const { data, error } = await sb()
      .from("automation_rules")
      .select("*")
      .eq("criteria_key", input.criteria_key)
      .eq("method", input.method)
      .eq("cities", `{${input.cities.join(",")}}`)
      .limit(1);
    if (error) fail("findRule", error);
    return data && data.length > 0 ? (data[0] as RuleRow) : null;
  };

  const existing = await find();
  if (existing) return { rule: existing, created: false };

  const { data, error } = await sb()
    .from("automation_rules")
    .insert({ ...input, enabled: false })
    .select("*")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const again = await find();
      if (again) return { rule: again, created: false };
    }
    fail("createRule", error);
  }
  return { rule: data as RuleRow, created: true };
}

export async function updateRule(
  id: string,
  patch: Partial<Pick<RuleRow, "enabled" | "stake_usd" | "max_price_cents" | "cities" | "label">>,
): Promise<RuleRow | null> {
  const { data, error } = await sb().from("automation_rules").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) fail("updateRule", error);
  return (data as RuleRow | null) ?? null;
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await sb().from("automation_rules").delete().eq("id", id);
  if (error) fail("deleteRule", error);
}

// ---- fills -------------------------------------------------------------------------------

export async function fillExists(ruleId: string, city: string, localDate: string, bracket: string): Promise<boolean> {
  const { data, error } = await sb()
    .from("automation_fills")
    .select("id")
    .eq("rule_id", ruleId)
    .eq("city", city)
    .eq("local_date", localDate)
    .eq("bracket", bracket)
    .limit(1);
  if (error) fail("fillExists", error);
  return (data ?? []).length > 0;
}

export async function insertFill(fill: NewFill): Promise<"inserted" | "duplicate"> {
  const { error } = await sb().from("automation_fills").insert(fill);
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return "duplicate";
    fail("insertFill", error);
  }
  return "inserted";
}

export async function listFills(limit: number): Promise<FillRow[]> {
  const { data, error } = await sb()
    .from("automation_fills")
    .select("*")
    .order("fired_at", { ascending: false })
    .limit(limit);
  if (error) fail("listFills", error);
  return (data ?? []) as FillRow[];
}

export async function listOpenFills(): Promise<FillRow[]> {
  const { data, error } = await sb().from("automation_fills").select("*").is("won", null).limit(500);
  if (error) fail("listOpenFills", error);
  return (data ?? []) as FillRow[];
}

export async function settleFill(
  id: string,
  update: { winning_bracket: string; won: boolean; pnl_usd: number; settled_at: string },
): Promise<void> {
  const { error } = await sb().from("automation_fills").update(update).eq("id", id).is("won", null);
  if (error) fail("settleFill", error);
}

export function emptyStats(): RuleStats {
  return { fills: 0, wins: 0, losses: 0, open: 0, pnl: 0, spent: 0 };
}

export function summarize(rows: Array<Pick<FillRow, "won" | "pnl_usd" | "spent_usd">>): RuleStats {
  const s = emptyStats();
  for (const r of rows) {
    s.fills += 1;
    s.spent += Number(r.spent_usd) || 0;
    if (r.won === true) s.wins += 1;
    else if (r.won === false) s.losses += 1;
    else s.open += 1;
    if (r.pnl_usd != null) s.pnl += Number(r.pnl_usd) || 0;
  }
  s.pnl = Math.round(s.pnl * 10000) / 10000;
  s.spent = Math.round(s.spent * 10000) / 10000;
  return s;
}

export async function statsByRule(): Promise<Record<string, RuleStats>> {
  const { data, error } = await sb()
    .from("automation_fills")
    .select("rule_id, won, pnl_usd, spent_usd")
    .not("rule_id", "is", null)
    .limit(10000);
  if (error) fail("statsByRule", error);
  const buckets: Record<string, Array<Pick<FillRow, "won" | "pnl_usd" | "spent_usd">>> = {};
  for (const r of (data ?? []) as Array<Pick<FillRow, "won" | "pnl_usd" | "spent_usd"> & { rule_id: string }>) {
    (buckets[r.rule_id] ??= []).push(r);
  }
  const out: Record<string, RuleStats> = {};
  for (const [id, rows] of Object.entries(buckets)) out[id] = summarize(rows);
  return out;
}
