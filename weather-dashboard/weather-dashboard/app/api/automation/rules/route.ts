import { NextResponse } from "next/server";
import { adminGuard } from "../../../../lib/automation/auth";
import { CITY_SCHEDULE, classifyBy, cityKey, parseBy } from "../../../../lib/automation/engine";
import {
  createRuleIfNew,
  emptyStats,
  listRules,
  statsByRule,
  type RuleMethod,
} from "../../../../lib/automation/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const METHODS: RuleMethod[] = ["combined", "linear", "reciprocal", "all"];

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  const blocked = await adminGuard(req);
  if (blocked) return blocked;
  try {
    const [rules, stats] = await Promise.all([listRules(), statsByRule()]);
    return NextResponse.json({
      automationEnabled: process.env.AUTOMATION_ENABLED === "true",
      rules: rules.map((r) => ({ ...r, stats: stats[r.id] ?? emptyStats() })),
    });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Could not load rules", 500);
  }
}

/** Arms a pinned row. New rules start switched off. */
export async function POST(req: Request) {
  const blocked = await adminGuard(req, { write: true });
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("Body must be JSON");
  }

  const label = typeof body.label === "string" ? body.label.trim().slice(0, 160) : "";
  const criteriaKey = typeof body.criteriaKey === "string" ? body.criteriaKey.trim() : "";
  const by = typeof body.by === "string" ? body.by.trim() : "";
  const method = typeof body.method === "string" ? (body.method as RuleMethod) : "combined";
  if (!label || !criteriaKey || !by) return bad("label, criteriaKey and by are required");
  if (!METHODS.includes(method)) return bad("method must be combined, linear, reciprocal or all");

  let specs;
  try {
    specs = parseBy(by);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Invalid by");
  }
  const cls = classifyBy(specs);
  if (cls.kind === "never") return bad(`This row cannot be automated: ${cls.reason}`);
  if (criteriaKey.split("|").length !== specs.length) return bad("criteriaKey does not match the dimensions in by");

  const rawCities = Array.isArray(body.cities) ? body.cities : [];
  const cities = Array.from(new Set(rawCities.map((c) => cityKey(c)).filter(Boolean))).sort();
  const unknown = cities.filter((c) => !Object.prototype.hasOwnProperty.call(CITY_SCHEDULE, c));
  if (unknown.length > 0) return bad(`Unknown cities: ${unknown.join(", ")}`);

  const stake = body.stakeUsd === undefined ? 1 : Number(body.stakeUsd);
  if (!Number.isFinite(stake) || stake < 1 || stake > 5) return bad("stakeUsd must be between 1 and 5");

  let maxPriceCents: number | null = null;
  if (body.maxPriceCents !== undefined && body.maxPriceCents !== null && body.maxPriceCents !== "") {
    const n = Number(body.maxPriceCents);
    if (!Number.isInteger(n) || n < 1 || n > 99) return bad("maxPriceCents must be a whole number from 1 to 99");
    maxPriceCents = n;
  }

  try {
    const { rule, created } = await createRuleIfNew({
      label,
      criteria_key: criteriaKey,
      by_param: by,
      dims: Array.isArray(body.dims) ? body.dims : null,
      method,
      cities,
      stake_usd: stake,
      max_price_cents: maxPriceCents,
    });
    return NextResponse.json({ rule, created }, { status: created ? 201 : 200 });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Could not save the rule", 500);
  }
}
