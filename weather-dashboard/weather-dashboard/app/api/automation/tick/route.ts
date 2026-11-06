import { NextResponse } from "next/server";
import { cronAuthorized } from "../../../../lib/automation/auth";
import { runTick } from "../../../../lib/automation/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * Called once a minute by cron on the droplet (see README). Not an admin route: it carries a shared secret
 * and is meant to be called on 127.0.0.1 only.
 */
export async function POST(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.AUTOMATION_ENABLED !== "true") return NextResponse.json({ ok: true, enabled: false });
  const summary = await runTick();
  return NextResponse.json({ ok: true, enabled: true, ...summary });
}
