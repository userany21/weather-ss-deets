import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/lib/automation/auth";
import { listRules } from "@/lib/automation/store";
import { getRuleBacktests } from "@/lib/automation/ruleBacktest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(req: NextRequest) {
  // Same guard as GET app/api/automation/rules/route.ts.
  const blocked = await adminGuard(req);
  if (blocked) return blocked;

  try {
    const rules = await listRules();
    const body = await getRuleBacktests(rules);
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[automation/rules/backtest] failed", error);
    return NextResponse.json({ error: "backtest_failed" }, { status: 500 });
  }
}
