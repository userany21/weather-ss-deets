/**
 * analyze-bracket-correlation.js
 *
 * Question: does the bracket that got ticked off the MOST during the day
 * (summed across the linear `high-temp` collection and the `reciprocal`
 * collection) tend to be the bracket that actually wins?
 *
 * Run with:
 *   MONGO_URI="..." node analyze-bracket-correlation.js
 *
 * Optional hour filter (positional arg, must come right after the script name):
 *   node analyze-bracket-correlation.js hour1
 *
 * This is CUMULATIVE from market open, not a single isolated hour: "hour1"
 * means "using every tick from 8am up through the end of the 9-10am hour."
 * Market window is treated as 8am-6pm local, 10 one-hour buckets:
 *   hour0 = through 8:00-8:59am   (8am-9am only)
 *   hour1 = through 9:00-9:59am   (8am-10am)
 *   hour2 = through 10:00-10:59am (8am-11am)
 *   hour3 = through 11:00-11:59am (8am-12pm)
 *   ...
 *   hour9 = through 5:00-5:59pm   (8am-6pm, the full day)
 * Bucketing is done off the `pacing_time` field (a local clock string like
 * "11:00 AM"), NOT off captured_at (which is UTC and doesn't track local
 * market hours consistently across cities).
 *
 * Optional flags:
 *   --city=Beijing        only analyze one city
 *   --csv=out.csv         also dump the per-city-day rows to a CSV
 */

require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("Set MONGO_URI env var first.");
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const positional = rawArgs.filter((a) => !a.startsWith("--"));
const args = Object.fromEntries(
  rawArgs
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    })
);

// Parse an hourN positional arg into a 0-9 bucket index, or null if absent.
let hourBucketFilter = null;
const hourArg = positional.find((a) => /^hour\d+$/i.test(a));
if (hourArg) {
  hourBucketFilter = parseInt(hourArg.replace(/^hour/i, ""), 10);
  if (hourBucketFilter < 0 || hourBucketFilter > 9) {
    console.error(`Invalid hour bucket "${hourArg}" — valid range is hour0 through hour9.`);
    process.exit(1);
  }
}

function bucketLabel(n) {
  // Cumulative window label: always starts at 8am, ends at the close of
  // hour bucket n.
  const endH = 8 + n + 1;
  const fmt = (h) => {
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${period}`;
  };
  return `8AM-${fmt(endH)}`;
}

function normBracket(b) {
  if (b === null || b === undefined) return null;
  return String(b).trim();
}

// Parse a pacing_time string like "9:25 AM" or "11:00 AM" into a 0-9 hour
// bucket (8am-6pm local, one bucket per clock hour). Returns null if it
// doesn't parse or falls outside the tracked window.
function pacingTimeToBucket(pacingTime) {
  if (!pacingTime) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(pacingTime.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const meridiem = m[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour < 8 || hour >= 18) return null; // outside 8am-6pm tracked window
  return hour - 8;
}

// Aggregate {city, local_date, bracket} -> tick count for one collection,
// optionally restricted to a single hour bucket (via pacing_time).
async function ticksByCityDateBracket(db, collName) {
  const match = { bracket: { $ne: null, $exists: true } };
  if (args.city) match.city = args.city;

  // Fetch raw docs (not grouped in Mongo) since bucketing requires parsing
  // the pacing_time string, which Mongo can't do cheaply in an aggregation.
  const docs = await db
    .collection(collName)
    .find(match, { projection: { city: 1, local_date: 1, bracket: 1, pacing_time: 1 } })
    .toArray();

  const map = new Map(); // key "city|date" -> Map(bracket -> count)
  for (const doc of docs) {
    if (hourBucketFilter !== null) {
      const bucket = pacingTimeToBucket(doc.pacing_time);
      // Cumulative: include everything from bucket 0 up through the
      // requested bucket (inclusive), i.e. "8am through end of hourN".
      if (bucket === null || bucket > hourBucketFilter) continue;
    }
    const key = `${doc.city}|${doc.local_date}`;
    if (!map.has(key)) map.set(key, new Map());
    const bMap = map.get(key);
    const bracket = normBracket(doc.bracket);
    bMap.set(bracket, (bMap.get(bracket) || 0) + 1);
  }
  return map;
}

// Get the resolved winning_bracket per city/date (from either collection,
// wherever outcome-tagging has happened)
async function winningBracketByCityDate(db, collName, into) {
  const match = { winning_bracket: { $ne: null, $exists: true } };
  if (args.city) match.city = args.city;

  const rows = await db
    .collection(collName)
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: { city: "$city", local_date: "$local_date" },
          winning_bracket: { $first: "$winning_bracket" },
        },
      },
    ])
    .toArray();

  for (const r of rows) {
    const key = `${r._id.city}|${r._id.local_date}`;
    into.set(key, normBracket(r.winning_bracket));
  }
}

function mergeCounts(mapA, mapB) {
  // union of keys, sums per-bracket counts
  const merged = new Map();
  for (const [key, bMap] of mapA) {
    merged.set(key, new Map(bMap));
  }
  for (const [key, bMap] of mapB) {
    if (!merged.has(key)) merged.set(key, new Map());
    const out = merged.get(key);
    for (const [bracket, count] of bMap) {
      out.set(bracket, (out.get(bracket) || 0) + count);
    }
  }
  return merged;
}

// Given a Map(bracket -> count), return { top: [brackets tied for max], sorted: [[bracket,count],...] }
function topBrackets(bMap) {
  const sorted = [...bMap.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return { top: [], sorted };
  const maxCount = sorted[0][1];
  const top = sorted.filter(([, c]) => c === maxCount).map(([b]) => b);
  return { top, sorted };
}

function rankOf(bracket, sorted) {
  // 1-indexed rank by count, ties share the same rank
  let rank = 1;
  for (const [b, c] of sorted) {
    if (b === bracket) return rank;
    rank++;
  }
  return null; // winning bracket never ticked at all
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db("weather");

  if (hourBucketFilter !== null) {
    console.log(
      `\nFiltering to cumulative window hour0-hour${hourBucketFilter} (${bucketLabel(
        hourBucketFilter
      )} local) — every tick from market open through that hour.\n` +
        `Winning brackets still reflect the full-day outcome — this checks how predictive ` +
        `the leading bracket is by that point in the day, not just that one hour.`
    );
  }

  const linearCounts = await ticksByCityDateBracket(db, "high-temp");
  const recCounts = await ticksByCityDateBracket(db, "reciprocal");
  const combinedCounts = mergeCounts(linearCounts, recCounts);

  const winners = new Map();
  await winningBracketByCityDate(db, "high-temp", winners);
  await winningBracketByCityDate(db, "reciprocal", winners);

  // Only evaluate city-days where we know the outcome
  const keys = [...winners.keys()].filter((k) => combinedCounts.has(k));

  const stats = {
    linear: { hits: 0, total: 0, ranks: [] },
    reciprocal: { hits: 0, total: 0, ranks: [] },
    combined: { hits: 0, total: 0, ranks: [] },
  };

  const cityStats = new Map(); // city -> same shape as `stats`
  function getCityStats(city) {
    if (!cityStats.has(city)) {
      cityStats.set(city, {
        linear: { hits: 0, total: 0, ranks: [] },
        reciprocal: { hits: 0, total: 0, ranks: [] },
        combined: { hits: 0, total: 0, ranks: [] },
      });
    }
    return cityStats.get(city);
  }

  const rows = [];

  for (const key of keys) {
    const [city, date] = key.split("|");
    const winningBracket = winners.get(key);

    const lMap = linearCounts.get(key) || new Map();
    const rMap = recCounts.get(key) || new Map();
    const cMap = combinedCounts.get(key) || new Map();

    const lTop = topBrackets(lMap);
    const rTop = topBrackets(rMap);
    const cTop = topBrackets(cMap);

    const lHit = lTop.top.includes(winningBracket);
    const rHit = rTop.top.includes(winningBracket);
    const cHit = cTop.top.includes(winningBracket);

    if (lMap.size) {
      stats.linear.total++;
      if (lHit) stats.linear.hits++;
      const rk = rankOf(winningBracket, lTop.sorted);
      if (rk) stats.linear.ranks.push(rk);

      const cs = getCityStats(city);
      cs.linear.total++;
      if (lHit) cs.linear.hits++;
      if (rk) cs.linear.ranks.push(rk);
    }
    if (rMap.size) {
      stats.reciprocal.total++;
      if (rHit) stats.reciprocal.hits++;
      const rk = rankOf(winningBracket, rTop.sorted);
      if (rk) stats.reciprocal.ranks.push(rk);

      const cs = getCityStats(city);
      cs.reciprocal.total++;
      if (rHit) cs.reciprocal.hits++;
      if (rk) cs.reciprocal.ranks.push(rk);
    }
    if (cMap.size) {
      stats.combined.total++;
      if (cHit) stats.combined.hits++;
      const rk = rankOf(winningBracket, cTop.sorted);
      if (rk) stats.combined.ranks.push(rk);

      const cs = getCityStats(city);
      cs.combined.total++;
      if (cHit) cs.combined.hits++;
      if (rk) cs.combined.ranks.push(rk);
    }

    rows.push({
      city,
      date,
      winningBracket,
      winningBracketTickCount: cMap.get(winningBracket) || 0,
      combinedTopBracket: cTop.top.join("/"),
      combinedTopCount: cTop.sorted[0] ? cTop.sorted[0][1] : 0,
      combinedHit: cHit,
      linearTopBracket: lTop.top.join("/"),
      linearHit: lHit,
      reciprocalTopBracket: rTop.top.join("/"),
      reciprocalHit: rHit,
      numBracketsTicked: cMap.size,
    });
  }

  // ---- Print per-city-day table ----
  console.log("\n=== Per city-day breakdown ===\n");
  for (const r of rows) {
    console.log(
      `${r.city} ${r.date} | winner=${r.winningBracket} (ticked ${r.winningBracketTickCount}x) | ` +
        `top-ticked=${r.combinedTopBracket} (${r.combinedTopCount}x) | ` +
        `combined ${r.combinedHit ? "HIT" : "miss"} | linear ${r.linearHit ? "HIT" : "miss"} | ` +
        `rec ${r.reciprocalHit ? "HIT" : "miss"} | brackets_ticked=${r.numBracketsTicked}`
    );
  }

  // ---- Summary ----
  function pct(n, d) {
    return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
  }
  function avg(arr) {
    return arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : "n/a";
  }

  console.log("\n=== Summary ===\n");
  if (hourBucketFilter !== null) {
    console.log(`Cumulative window: hour0-hour${hourBucketFilter} (${bucketLabel(hourBucketFilter)} local)`);
  }
  console.log(`Resolved city-days analyzed: ${rows.length}`);
  console.log(
    `Combined (linear+reciprocal) top-ticked bracket == winner: ${stats.combined.hits}/${stats.combined.total} (${pct(
      stats.combined.hits,
      stats.combined.total
    )})`
  );
  console.log(
    `Linear-only top-ticked bracket == winner:                 ${stats.linear.hits}/${stats.linear.total} (${pct(
      stats.linear.hits,
      stats.linear.total
    )})`
  );
  console.log(
    `Reciprocal-only top-ticked bracket == winner:              ${stats.reciprocal.hits}/${stats.reciprocal.total} (${pct(
      stats.reciprocal.hits,
      stats.reciprocal.total
    )})`
  );
  console.log(`\nAvg rank (by tick count) of the actual winning bracket:`);
  console.log(`  combined:   ${avg(stats.combined.ranks)}`);
  console.log(`  linear:     ${avg(stats.linear.ranks)}`);
  console.log(`  reciprocal: ${avg(stats.reciprocal.ranks)}`);

  // Baseline comparison: if brackets were random, hit rate would be roughly
  // 1 / (avg number of distinct brackets ticked per day)
  const avgBracketsTicked =
    rows.reduce((a, r) => a + r.numBracketsTicked, 0) / (rows.length || 1);
  console.log(
    `\nAvg distinct brackets ticked per city-day: ${avgBracketsTicked.toFixed(
      2
    )} (naive random baseline hit rate ~= ${pct(1, avgBracketsTicked)})`
  );

  // ---- Per-city breakdown ----
  console.log("\n=== Per-city breakdown ===\n");
  const cityRows = [...cityStats.entries()]
    .map(([city, cs]) => ({
      city,
      days: cs.combined.total,
      combinedHits: cs.combined.hits,
      combinedPct: pct(cs.combined.hits, cs.combined.total),
      linearHits: cs.linear.hits,
      linearTotal: cs.linear.total,
      linearPct: pct(cs.linear.hits, cs.linear.total),
      recHits: cs.reciprocal.hits,
      recTotal: cs.reciprocal.total,
      recPct: pct(cs.reciprocal.hits, cs.reciprocal.total),
      combinedAvgRank: avg(cs.combined.ranks),
    }))
    // worst combined hit rate first, so the problem cities float to the top
    .sort((a, b) => a.combinedHits / (a.days || 1) - b.combinedHits / (b.days || 1));

  const cityColWidth = Math.max(...cityRows.map((r) => r.city.length), "city".length) + 2;
  console.log(
    `${"city".padEnd(cityColWidth)}days  combined        linear          reciprocal      avg_rank`
  );
  for (const r of cityRows) {
    console.log(
      `${r.city.padEnd(cityColWidth)}` +
        `${String(r.days).padEnd(6)}` +
        `${`${r.combinedHits}/${r.days} (${r.combinedPct})`.padEnd(16)}` +
        `${`${r.linearHits}/${r.linearTotal} (${r.linearPct})`.padEnd(16)}` +
        `${`${r.recHits}/${r.recTotal} (${r.recPct})`.padEnd(16)}` +
        `${r.combinedAvgRank}`
    );
  }

  if (args.csv) {
    const fs = require("fs");
    const header = Object.keys(rows[0] || {}).join(",");
    const lines = rows.map((r) => Object.values(r).join(","));
    fs.writeFileSync(args.csv, [header, ...lines].join("\n"));
    console.log(`\nWrote CSV to ${args.csv}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});