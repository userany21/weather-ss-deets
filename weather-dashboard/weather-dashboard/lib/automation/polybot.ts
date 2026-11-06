import { createHmac } from "node:crypto";

/**
 * Signed push to PolyBot. One request, one reply, no status lookup afterwards.
 * Placeholders for .env.local:
 *   POLYBOT_BUY_URL          e.g. https://YOUR-POLYBOT-HOST/api/internal/weather-buy
 *   POLYBOT_INTENT_SECRET    same value as WEATHER_INTENT_SECRET on PolyBot (openssl rand -hex 32)
 *   POLYBOT_TIMEOUT_MS       optional, default 20000
 *
 * Signature: hex HMAC-SHA256 over `${timestampSeconds}.${rawBody}` with the shared secret.
 */

export interface BuyIntent {
  v: 1;
  intentId: string;
  ruleId: string;
  ruleLabel: string;
  city: string;
  localDate: string;
  bracket: string;
  stakeUsd: number;
  maxPriceCents: number | null;
  signalPriceCents: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface BuyReply {
  status: "filled" | "rejected" | "pending" | "unknown";
  reason?: string;
  tokenId?: string;
  avgPrice?: number;
  shares?: number;
  spentUsd?: number;
  orderId?: string;
  duplicate?: boolean;
}

export function signBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Returns PolyBot's reply, or null when the call timed out or the network failed. */
export async function sendBuy(intent: BuyIntent): Promise<BuyReply | null> {
  const url = process.env.POLYBOT_BUY_URL;
  const secret = process.env.POLYBOT_INTENT_SECRET;
  if (!url || !secret) throw new Error("POLYBOT_BUY_URL and POLYBOT_INTENT_SECRET must be set");

  const rawBody = JSON.stringify(intent);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const timeoutMs = Number(process.env.POLYBOT_TIMEOUT_MS ?? 20000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 20000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wx-timestamp": timestamp,
        "x-wx-signature": signBody(secret, timestamp, rawBody),
      },
      body: rawBody,
      signal: ctrl.signal,
      cache: "no-store",
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const reason = body && typeof body === "object" && "reason" in body ? String((body as { reason: unknown }).reason) : `http_${res.status}`;
      return { status: "rejected", reason };
    }
    if (!body || typeof body !== "object") return { status: "rejected", reason: "bad_reply" };
    return body as BuyReply;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
