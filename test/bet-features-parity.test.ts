import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { getDb } from "@/lib/mongodb";
import {
  BRACKET_CAP,
  aggregate,
  betDocToRow,
  betsForRule,
  decisionSlot,
  rowsMatching,
  type DimensionSpec,
  type FeatureRow,
} from "@/lib/stats-aggregator";
import { parseScriptRule } from "@/lib/script-rule";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden");
const FIRST_TICK_IDS = new Set(["price", "first_tick_hour"]);

interface GoldenRule {
  hash: string;
  rule: string;
  n: number;
  win: number;
  avgEdge: number;
  t: number;
}

function loadRules(): GoldenRule[] {
  const seen = new Set<string>();
  const rules: GoldenRule[] = [];
  for (const line of fs.readFileSync(path.join(GOLDEN, "dump_index.txt"), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [hash, rule, , stats] = line.split("\t");
    if (seen.has(hash)) continue;
    seen.add(hash);
    const field = Object.fromEntries(stats.split(" ").map((part) => part.split("=")));
    rules.push({
      hash,
      rule,
      n: Number(field.n),
      win: Number(field.win),
      avgEdge: Number(field.avg_edge),
      t: Number(field.t),
    });
  }
  return rules;
}

function goldenIds(hash: string): Set<string> {
  const file = path.join(GOLDEN, `dump_${hash}.csv`);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",");
  const city = header.indexOf("city");
  const date = header.indexOf("local_date");
  const bracket = header.indexOf("bracket");
  const ids = new Set<string>();
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    ids.add(`${cols[city]}|${cols[date]}|${cols[bracket].trim()}`);
  }
  return ids;
}

function idOf(row: { city: string; local_date: string; bracket: string }): string {
  return `${row.city}|${row.local_date}|${String(row.bracket).trim()}`;
}

type Cause = "cap" | "gate" | "null price" | "method priority" | "first-tick limit" | "other";

function applyFirstTick(rows: FeatureRow[], dimensions: DimensionSpec[]): FeatureRow[] {
  const d = decisionSlot(dimensions);
  if (d.kind !== "slot" || !dimensions.some((x) => FIRST_TICK_IDS.has(x.id))) return rows;
  return rows.filter(
    (r) => r.first_tick_hour != null && r.first_tick_hour >= 0 && r.first_tick_hour <= d.slot
  );
}

function classify(
  id: string,
  side: "missing" | "extra",
  dimensions: DimensionSpec[],
  keys: string[],
  allRows: FeatureRow[]
): Cause {
  const [city, localDate, bracket] = id.split("|");
  const dayRows = allRows.filter((r) => r.city === city && r.local_date === localDate);
  const matched = applyFirstTick(rowsMatching(dayRows, dimensions, keys), dimensions);
  const mine = matched.filter((r) => String(r.bracket).trim() === bracket);

  if (side === "missing" && mine.length === 0) {
    const before = rowsMatching(dayRows, dimensions, keys).filter(
      (r) => String(r.bracket).trim() === bracket
    );
    if (before.length > 0) return "first-tick limit";
    return "other";
  }

  const brackets = new Set(matched.map((r) => String(r.bracket).trim()));
  if (brackets.size > BRACKET_CAP) return "cap";

  const methodDim = dimensions.findIndex((d) => d.id === "method");
  if (methodDim >= 0) {
    const wider = dimensions.filter((_, i) => i !== methodDim);
    const widerKeys = keys.filter((_, i) => i !== methodDim);
    const across = applyFirstTick(rowsMatching(dayRows, wider, widerKeys), wider);
    const acrossCount = new Set(across.map((r) => String(r.bracket).trim())).size;
    if (acrossCount > BRACKET_CAP) return "cap";
  }

  const d = decisionSlot(dimensions);
  const priced = mine.filter((r) => {
    if (d.kind === "slot") return typeof r.close_price_cents?.[d.slot] === "number";
    return r.has_price && typeof r.first_tick_price_cents === "number";
  });
  if (mine.length > 0 && priced.length === 0) return "null price";
  const open = priced.filter((r) =>
    d.kind === "slot" ? r.gate_open?.[d.slot] === true : r.first_tick_gate_open === true
  );
  if (priced.length > 0 && open.length === 0) return "gate";

  const methods = new Set(mine.map((r) => r.method));
  if (methods.size > 1) return "method priority";
  return "other";
}

test("P1 and P3: bet sets match the golden files", { timeout: 300_000 }, async () => {
  const maxDate = fs.readFileSync(path.join(GOLDEN, "MAX_DATE.txt"), "utf8").trim();
  const rules = loadRules();
  assert.ok(rules.length > 0, "dump_index.txt has no rules");

  const db = await getDb();
  const docs = await db.collection("bet_features").find({ local_date: { $lte: maxDate } }).toArray();
  const allRows = docs.map((d) => betDocToRow(d as never));

  const causes = new Map<Cause, number>();
  const details: string[] = [];
  for (const golden of rules) {
    const parsed = parseScriptRule(golden.rule);
    const bets = await betsForRule(parsed.dimensions, parsed.criteriaKey.split("|"), { maxDate });
    const got = new Set(bets.map((b) => idOf(b.row)));
    const want = goldenIds(golden.hash);
    const missing = [...want].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !want.has(id));
    for (const id of missing) {
      const cause = classify(id, "missing", parsed.dimensions, parsed.criteriaKey.split("|"), allRows);
      causes.set(cause, (causes.get(cause) ?? 0) + 1);
      details.push(`missing\t${cause}\t${golden.hash}\t${id}`);
    }
    for (const id of extra) {
      const cause = classify(id, "extra", parsed.dimensions, parsed.criteriaKey.split("|"), allRows);
      causes.set(cause, (causes.get(cause) ?? 0) + 1);
      details.push(`extra\t${cause}\t${golden.hash}\t${id}`);
    }
    console.log(
      `${golden.hash} golden=${want.size} scored=${got.size} missing=${missing.length} extra=${extra.length}`
    );
  }

  console.log("P3 causes:", Object.fromEntries(causes));
  for (const line of details) console.log(line);
  assert.equal(details.length, 0, `${details.length} bet-set differences`);
});

test("P2: page numbers match dump_index.txt", { timeout: 300_000 }, async () => {
  const maxDate = fs.readFileSync(path.join(GOLDEN, "MAX_DATE.txt"), "utf8").trim();
  process.env.STATS_SOURCE = "bet_features";
  for (const golden of loadRules()) {
    const parsed = parseScriptRule(golden.rule);
    const { buckets } = await aggregate(
      { dateTo: maxDate, minCount: 1, dedupe: true },
      parsed.dimensions
    );
    const bucket = buckets.find((b) => b.key === parsed.criteriaKey);
    assert.ok(bucket, `no bucket ${parsed.criteriaKey} for ${golden.rule}`);
    assert.equal(bucket.count, golden.n, `${golden.hash} count`);
    assert.ok(bucket.win_rate != null && Math.abs(bucket.win_rate - golden.win) <= 0.001, `${golden.hash} win ${bucket.win_rate} vs ${golden.win}`);
    assert.ok(
      bucket.avg_edge_cents != null && Math.abs(bucket.avg_edge_cents - golden.avgEdge) <= 0.1,
      `${golden.hash} avg_edge ${bucket.avg_edge_cents} vs ${golden.avgEdge}`
    );
    assert.ok(bucket.t != null && Math.abs(bucket.t - golden.t) <= 0.1, `${golden.hash} t ${bucket.t} vs ${golden.t}`);
    console.log(
      `${golden.hash} count=${bucket.count} win=${bucket.win_rate?.toFixed(4)} edge=${bucket.avg_edge_cents?.toFixed(2)} t=${bucket.t?.toFixed(2)}`
    );
  }
});
