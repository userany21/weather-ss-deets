import { createRemoteJWKSet, jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Admin and cron guards for /api/automation/*.
 *
 * Port 3002 can be reached without Cloudflare, so a Cloudflare Access header alone is not trusted.
 * The Access JWT is verified here on every admin call (signature, issuer, audience, allowed email).
 * Everything fails closed: missing config means 503, not "allow".
 *
 * Placeholders for .env.local:
 *   CF_ACCESS_TEAM_DOMAIN   e.g. yourteam.cloudflareaccess.com
 *   CF_ACCESS_AUD           the Application Audience (AUD) tag of the Access app
 *   AUTOMATION_ADMIN_EMAILS comma-separated allowed emails
 *   AUTOMATION_CRON_SECRET  shared with the cron line that calls /api/automation/tick
 */

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksTeam = "";

function getJwks(team: string) {
  if (!jwks || jwksTeam !== team) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksTeam = team;
  }
  return jwks;
}

export async function requireAdmin(req: Request): Promise<{ email: string }> {
  if (process.env.NODE_ENV !== "production" && process.env.AUTOMATION_DEV_BYPASS === "1") {
    return { email: "dev@localhost" };
  }
  const team = (process.env.CF_ACCESS_TEAM_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = process.env.CF_ACCESS_AUD ?? "";
  const admins = (process.env.AUTOMATION_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!team || !aud || admins.length === 0) throw new AuthError(503, "Admin access is not configured");

  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) throw new AuthError(401, "Sign in through Cloudflare Access");

  let email = "";
  try {
    const { payload } = await jwtVerify(token, getJwks(team), { issuer: `https://${team}`, audience: aud });
    email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  } catch {
    throw new AuthError(401, "Access token rejected");
  }
  if (!email || !admins.includes(email)) throw new AuthError(403, "Not an admin");
  return { email };
}

/** State-changing calls must be JSON and come from this site, so a cross-site form cannot drive them. */
export function assertWriteRequest(req: Request, hasBody: boolean): void {
  if (hasBody && !(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    throw new AuthError(415, "Send application/json");
  }
  const origin = req.headers.get("origin");
  if (!origin) return;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AuthError(403, "Bad origin");
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const extra = (process.env.AUTOMATION_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (originHost !== host && !extra.includes(originHost)) throw new AuthError(403, "Origin mismatch");
}

/** Returns a response when the call must stop, or null when it may continue. */
export async function adminGuard(
  req: Request,
  opts: { write?: boolean; hasBody?: boolean } = {},
): Promise<NextResponse | null> {
  try {
    if (opts.write) assertWriteRequest(req, opts.hasBody ?? true);
    await requireAdmin(req);
    return null;
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Auth check failed" }, { status: 500 });
  }
}

export function cronAuthorized(req: Request): boolean {
  const secret = process.env.AUTOMATION_CRON_SECRET ?? "";
  const got = req.headers.get("x-automation-cron") ?? "";
  if (!secret || secret.length < 16) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
