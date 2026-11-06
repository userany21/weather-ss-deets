import { NextResponse } from "next/server";
import { adminGuard } from "../../../../lib/automation/auth";
import { listFills, summarize } from "../../../../lib/automation/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(req: Request) {
  const blocked = await adminGuard(req);
  if (blocked) return blocked;
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 500) : 100;
  try {
    const fills = await listFills(limit);
    return NextResponse.json({ fills, summary: summarize(fills) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load fills" }, { status: 500 });
  }
}
