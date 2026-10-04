// fix-brackets.js
// Cleans up docs in weather.high-temp and weather.reciprocal whose stored `bracket`
// was picked with the old ".8 round-up" instead of standard rounding.
//
// For each doc: target = Math.round(weighted_avg), checked against the stored bracket
// with the same parse/match logic the n8n workflow uses.
//   bracket matches target  -> untouched (yes_price / yes_price_cents kept)
//   bracket sits BELOW it   -> stale: bracket replaced with the real Polymarket bracket label
//                              for that event; yes_price + yes_price_cents set to null
//   bracket sits ABOVE it   -> left alone (n8n bumps to the next live bracket when price < 1c)
//   no bracket / no avg     -> skipped
// Original values are saved on the doc as `bracket_fix`, so it's reversible.
//
// Usage (Node 18+):
//   npm i mongodb dotenv
//   .env: MONGO_URI=...   (optional MONGO_DB, defaults to "weather")
//
//   node fix-brackets.js                            dry run
//   node fix-brackets.js --apply                    write changes
//   node fix-brackets.js --purge-features           dry run: stats_features city-days to drop
//   node fix-brackets.js --purge-features --apply   drop stats_features rows for fixed city-days
//                                                   (then run: node stats/build-feature-table.js --force)

require("dotenv").config();
const { MongoClient } = require("mongodb");

const URI = process.env.MONGO_URI;
const DB = process.env.MONGO_DB || "weather";
const COLLECTIONS = ["high-temp", "reciprocal"];
const APPLY = process.argv.includes("--apply");
const PURGE = process.argv.includes("--purge-features");
const BATCH = 500;
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- same bracket logic as the n8n nodes -------------------------------------------------

function parseBracket(title) {
  try {
    if (title.includes("or below")) {
      return { type: "below", low: -Infinity, high: parseInt(title.match(/-?\d+/)[0], 10) };
    }
    if (title.includes("or higher")) {
      return { type: "above", low: parseInt(title.match(/-?\d+/)[0], 10), high: Infinity };
    }
    const range = title.match(/(\d+)\s*-\s*(\d+)/);
    if (range) return { type: "range", low: parseInt(range[1], 10), high: parseInt(range[2], 10) };
    const n = parseInt(title.match(/-?\d+/)[0], 10);
    return { type: "exact", low: n, high: n };
  } catch {
    return null;
  }
}

const bracketMatches = (b, v) => v >= b.low && v <= b.high;

function classify(doc) {
  const wa = doc.weighted_avg;
  if (typeof wa !== "number" || !Number.isFinite(wa)) return { kind: "skip", reason: "no weighted_avg" };
  if (typeof doc.bracket !== "string" || !doc.bracket.trim()) return { kind: "skip", reason: "no bracket" };
  const parsed = parseBracket(doc.bracket);
  if (!parsed) return { kind: "skip", reason: `unparseable bracket: ${doc.bracket}` };

  const target = Math.round(wa);
  if (bracketMatches(parsed, target)) return { kind: "correct", target };
  if (parsed.high < target) return { kind: "stale", target }; // stored bracket is below the right one
  return { kind: "above", target }; // stored bracket is above: likely an n8n "bump", don't touch
}

// ---- Polymarket event bracket labels (cached per city-day) -------------------------------

const eventCache = new Map();

async function getEventTitles(city, localDate) {
  const key = `${city}|${localDate}`;
  if (eventCache.has(key)) return eventCache.get(key);

  const [y, m, d] = localDate.split("-");
  const citySlug = city.toLowerCase().replace(/\s+/g, "-");
  const slug = `highest-temperature-in-${citySlug}-on-${MONTHS[parseInt(m, 10) - 1]}-${parseInt(d, 10)}-${y}`;

  let titles = null;
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events/slug/${slug}`);
    if (res.ok) {
      const json = await res.json();
      const ev = Array.isArray(json) ? json[0] : json;
      titles = (ev?.markets || []).map((mk) => mk.groupItemTitle).filter(Boolean);
      if (!titles.length) titles = null;
    }
  } catch {
    titles = null;
  }
  eventCache.set(key, titles); // failures cached too; re-run the script to retry them
  await sleep(120);
  return titles;
}

// ---- main pass ---------------------------------------------------------------------------

async function fixBrackets(db) {
  for (const name of COLLECTIONS) {
    const col = db.collection(name);
    const docs = await col
      .find({}, { projection: { city: 1, local_date: 1, pacing_time: 1, weighted_avg: 1, bracket: 1, yes_price: 1, yes_price_cents: 1 } })
      .toArray();

    const stats = { scanned: docs.length, correct: 0, stale: 0, fixed: 0, above: 0, skipped: 0, unresolved: 0 };
    const skipReasons = new Map();
    const staleList = [];
    const aboveExamples = [];
    const fixedExamples = [];
    const cityDays = new Set();

    for (const doc of docs) {
      const c = classify(doc);
      if (c.kind === "correct") stats.correct++;
      else if (c.kind === "stale") { stats.stale++; staleList.push({ doc, target: c.target }); }
      else if (c.kind === "above") {
        stats.above++;
        if (aboveExamples.length < 5) {
          aboveExamples.push(`${doc.city} ${doc.local_date} ${doc.pacing_time} | avg ${doc.weighted_avg} | stored ${doc.bracket}`);
        }
      } else {
        stats.skipped++;
        skipReasons.set(c.reason, (skipReasons.get(c.reason) || 0) + 1);
      }
    }

    let ops = [];
    for (const { doc, target } of staleList) {
      const titles = await getEventTitles(doc.city, doc.local_date);
      const newBracket = titles?.find((t) => {
        const p = parseBracket(t);
        return p && bracketMatches(p, target);
      });
      if (!newBracket) { stats.unresolved++; continue; }

      stats.fixed++;
      cityDays.add(`${doc.city} ${doc.local_date}`);
      if (fixedExamples.length < 10) {
        fixedExamples.push(
          `${doc.city} ${doc.local_date} ${doc.pacing_time} | avg ${doc.weighted_avg} | ${doc.bracket} -> ${newBracket} | price ${doc.yes_price_cents ?? "-"}c -> null`
        );
      }

      if (APPLY) {
        ops.push({
          updateOne: {
            filter: { _id: doc._id, bracket: doc.bracket },
            update: {
              $set: {
                bracket: newBracket,
                yes_price: null,
                yes_price_cents: null,
                bracket_fix: {
                  bracket: doc.bracket,
                  yes_price: doc.yes_price ?? null,
                  yes_price_cents: doc.yes_price_cents ?? null,
                  fixed_at: new Date(),
                },
              },
            },
          },
        });
        if (ops.length >= BATCH) { await col.bulkWrite(ops, { ordered: false }); ops = []; }
      }
    }
    if (APPLY && ops.length) await col.bulkWrite(ops, { ordered: false });

    console.log(`== ${name} ==`);
    console.log(`scanned ${stats.scanned}`);
    console.log(`  correct, kept as is:            ${stats.correct}`);
    console.log(`  stale, ${APPLY ? "fixed" : "would fix"}:               ${stats.fixed}  (${cityDays.size} city-days)`);
    console.log(`  stale, couldn't resolve event:  ${stats.unresolved}  (untouched, re-run to retry)`);
    console.log(`  bracket above target, ignored:  ${stats.above}  (likely n8n bumps)`);
    console.log(`  skipped:                        ${stats.skipped}`);
    if (fixedExamples.length) { console.log("fix examples:"); fixedExamples.forEach((e) => console.log("  " + e)); }
    if (aboveExamples.length) { console.log("above-target examples (left alone):"); aboveExamples.forEach((e) => console.log("  " + e)); }
    if (skipReasons.size) { console.log("skipped:"); for (const [r, n] of skipReasons) console.log(`  ${n} x ${r}`); }
    console.log();
  }
}

// ---- stats_features cleanup --------------------------------------------------------------
// build-feature-table.js upserts on (city, local_date, bracket, method) and never deletes the
// old bracket key, so rows under the old labels would be left behind as orphans.

async function purgeFeatures(db) {
  const pairs = new Map();
  for (const name of COLLECTIONS) {
    const rows = await db
      .collection(name)
      .find({ bracket_fix: { $exists: true } }, { projection: { city: 1, local_date: 1 } })
      .toArray();
    for (const r of rows) pairs.set(`${r.city}|${r.local_date}`, { city: r.city, local_date: r.local_date });
  }

  console.log(`city-days with a bracket fix: ${pairs.size}`);
  if (!pairs.size) return;

  const feat = db.collection("stats_features");
  if (!APPLY) {
    const n = await feat.countDocuments({ $or: [...pairs.values()] });
    console.log(`would delete ${n} stats_features rows. Add --apply to delete.`);
    return;
  }
  const ops = [...pairs.values()].map((p) => ({ deleteMany: { filter: p } }));
  const res = await feat.bulkWrite(ops, { ordered: false });
  console.log(`deleted ${res.deletedCount} stats_features rows. Now run: node stats/build-feature-table.js --force`);
}

async function main() {
  if (!URI) {
    console.error("Set MONGO_URI in .env");
    process.exit(1);
  }
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);
  console.log(`db: ${DB} | ${APPLY ? "APPLYING changes" : "DRY RUN (add --apply to write)"}\n`);
  try {
    if (PURGE) await purgeFeatures(db);
    else await fixBrackets(db);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseBracket, bracketMatches, classify };