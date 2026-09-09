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
 * Optional flags:
 *   --city=Beijing        only analyze one city
 *   --csv=out.csv         also dump the per-city-day rows to a CSV
 */

const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("Set MONGO_URI env var first.");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

function normBracket(b) {
  if (b === null || b === undefined) return null;
  return String(b).trim();
}

// Aggregate {city, local_date, bracket} -> tick count for one collection
async function ticksByCityDateBracket(db, collName) {
  const match = { bracket: { $ne: null, $exists: true } };
  if (args.city) match.city = args.city;

  const rows = await db
    .collection(collName)
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: { city: "$city", local_date: "$local_date", bracket: "$bracket" },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const map = new Map(); // key "city|date" -> Map(bracket -> count)
  for (const r of rows) {
    const key = `${r._id.city}|${r._id.local_date}`;
    if (!map.has(key)) map.set(key, new Map());
    const bMap = map.get(key);
    const bracket = normBracket(r._id.bracket);
    bMap.set(bracket, (bMap.get(bracket) || 0) + r.count);
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
    }
    if (rMap.size) {
      stats.reciprocal.total++;
      if (rHit) stats.reciprocal.hits++;
      const rk = rankOf(winningBracket, rTop.sorted);
      if (rk) stats.reciprocal.ranks.push(rk);
    }
    if (cMap.size) {
      stats.combined.total++;
      if (cHit) stats.combined.hits++;
      const rk = rankOf(winningBracket, cTop.sorted);
      if (rk) stats.combined.ranks.push(rk);
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
