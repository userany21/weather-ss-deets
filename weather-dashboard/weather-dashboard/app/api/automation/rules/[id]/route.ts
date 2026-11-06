import { NextResponse } from "next/server";
import { adminGuard } from "../../../../../lib/automation/auth";
import { CITY_SCHEDULE, cityKey } from "../../../../../lib/automation/engine";
import { deleteRule, updateRule, type RuleRow } from "../../../../../lib/automation/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const blocked = await adminGuard(req, { write: true });
  if (blocked) return blocked;
  if (!UUID.test(params.id)) return bad("Bad rule id");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("Body must be JSON");
  }

  const patch: Partial<Pick<RuleRow, "enabled" | "stake_usd" | "max_price_cents" | "cities" | "label">> = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return bad("enabled must be true or false");
    patch.enabled = body.enabled;
  }
  if (body.stakeUsd !== undefined) {
    const n = Number(body.stakeUsd);
    if (!Number.isFinite(n) || n < 1 || n > 5) return bad("stakeUsd must be between 1 and 5");
    patch.stake_usd = n;
  }
  if (body.maxPriceCents !== undefined) {
    if (body.maxPriceCents === null || body.maxPriceCents === "") patch.max_price_cents = null;
    else {
      const n = Number(body.maxPriceCents);
      if (!Number.isInteger(n) || n < 1 || n > 99) return bad("maxPriceCents must be a whole number from 1 to 99");
      patch.max_price_cents = n;
    }
  }
  if (body.cities !== undefined) {
    if (!Array.isArray(body.cities)) return bad("cities must be a list");
    const cities = Array.from(new Set(body.cities.map((c) => cityKey(c)).filter(Boolean))).sort();
    const unknown = cities.filter((c) => !Object.prototype.hasOwnProperty.call(CITY_SCHEDULE, c));
    if (unknown.length > 0) return bad(`Unknown cities: ${unknown.join(", ")}`);
    patch.cities = cities;
  }
  if (body.label !== undefined) {
    if (typeof body.label !== "string" || !body.label.trim()) return bad("label cannot be empty");
    patch.label = body.label.trim().slice(0, 160);
  }
  if (Object.keys(patch).length === 0) return bad("Nothing to update");

  try {
    const rule = await updateRule(params.id, patch);
    if (!rule) return bad("Rule not found", 404);
    return NextResponse.json({ rule });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Could not update the rule", 500);
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const blocked = await adminGuard(req, { write: true, hasBody: false });
  if (blocked) return blocked;
  if (!UUID.test(params.id)) return bad("Bad rule id");
  try {
    await deleteRule(params.id); // fills keep their own copy of the rule label and criteria
    return NextResponse.json({ ok: true });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Could not delete the rule", 500);
  }
}
