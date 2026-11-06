// Sends a SIGNED test message to PolyBot. It can never place a trade: the bracket does not exist,
// so even a fully valid message ends as "rejected".
// Run from weather-dashboard/weather-dashboard:
//   POLYBOT_BUY_URL=... POLYBOT_INTENT_SECRET=... node scripts/send-test-intent.mjs <case>
// cases: good | bad-sig | old-ts | expired | again
//   good     valid signature. Expect "disabled" while PolyBot is off, else a rejection like "bracket_not_found".
//   bad-sig  one hex digit flipped.            Expect HTTP 401 bad_signature.
//   old-ts   valid signature, 10 minutes old.  Expect HTTP 401 stale_timestamp.
//   expired  valid signature, intent expired.  Expect "expired".
//   again    same intentId as `good`.          Expect the same rejection with duplicate: true (PolyBot must be enabled).
import { createHash, createHmac } from "node:crypto";

const url = process.env.POLYBOT_BUY_URL;
const secret = process.env.POLYBOT_INTENT_SECRET;
if (!url || !secret) {
  console.error("Set POLYBOT_BUY_URL and POLYBOT_INTENT_SECRET.");
  process.exit(1);
}
const kind = (process.argv[2] ?? "good").toLowerCase();
const now = new Date();

const intent = {
  v: 1,
  intentId: createHash("sha256").update("wx-signature-test").digest("hex").slice(0, 32),
  ruleId: "signature-test",
  ruleLabel: "signature test",
  city: "seoul",
  localDate: now.toISOString().slice(0, 10),
  bracket: "ZZ-TEST-NOT-A-BRACKET",
  stakeUsd: 1,
  maxPriceCents: 50,
  signalPriceCents: null,
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + (kind === "expired" ? -1000 : 60_000)).toISOString(),
};

const body = JSON.stringify(intent);
let ts = Math.floor(Date.now() / 1000);
if (kind === "old-ts") ts -= 600;
let sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
if (kind === "bad-sig") sig = (sig[0] === "0" ? "1" : "0") + sig.slice(1);

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-wx-timestamp": String(ts), "x-wx-signature": sig },
  body,
});
console.log(res.status, await res.text());
