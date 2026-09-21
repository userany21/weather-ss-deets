/**
 * stats/build-feature-table.js
 *
 * Builds (or incrementally refreshes) the `stats_features` collection in MongoDB.
 * One document per (city, local_date, bracket, method) tuple.
 *
 * Methods produced:
 *   linear     — reads from `high-temp` collection only
 *   reciprocal — reads from `reciprocal` collection only
 *   combined   — merges tick counts from both; first-tick = earliest captured_at across both
 *
 * Usage:
 *   MONGO_URI="..." node build-feature-table.js              # last 7 days
 *   MONGO_URI="..." node build-feature-table.js --days=30
 *   MONGO_URI="..." node build-feature-table.js --force      # all history
 *   MONGO_URI="..." node build-feature-table.js --city=tokyo
 *   MONGO_URI="..." node build-feature-table.js --dry-run    # print counts only, no writes
 *
 * Design notes from analyze-bracket-correlation.js:
 *   - bracket: null docs (pre-n8n era) are explicitly excluded.
 *   - Tie handling: all brackets tied for the max cumulative count at hour N are
 *     marked is_leader_through_hour[N]=true, matching the existing script's behavior.
 *   - rank_through_hour uses sequential position in the sorted array (1,2,3,...),
 *     NOT tied ranks. This matches what rankOf() actually does in the existing script
 *     (the comment there is wrong).
 *   - pacing_time is already local clock time — no timezone conversion applied.
 *   - yes_price_cents may be null on older docs; has_price=false for those rows,
 *     and edge_cents is left null.
 *   - winning_bracket is collected from both collections; whichever has it first wins.
 *   - Unresolved city-days get resolved=false, won=null, edge_cents=null.
 */

require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("Set MONGO_URI env var first.");
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const args = Object.fromEntries(
  rawArgs
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    })
);

const FORCE = !!args.force;
const DAYS = FORCE ? null : parseInt(args.days ?? "7", 10);
const CITY_FILTER = args.city ?? null;
const DRY_RUN = !!args["dry-run"];

const NUM_HOUR_BUCKETS = 10; // hour0..hour9  (8am-6pm local, one bucket per clock hour)
const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Utility — mirrors the logic already in analyze-bracket-correlation.js
// ---------------------------------------------------------------------------

function normBracket(b) {
  if (b === null || b === undefined) return null;
  return String(b).trim();
}

/**
 * Parse a pacing_time string like "9:25 AM" into a 0-9 bucket index.
 * 8am = 0, 9am = 1, ..., 5pm = 9. Returns null outside the window or on
 * parse failure.
 */
function pacingTimeToBucket(pt) {
  if (!pt) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(pt.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const meridiem = m[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour < 8 || hour >= 18) return null;
  return hour - 8;
}

/** Build the ISO date string for `--days` ago as the dateFrom cutoff. */
function buildDateFrom() {
  if (DAYS === null) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - DAYS);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// MongoDB helpers
// ---------------------------------------------------------------------------

async function fetchTicks(col, dateFrom) {
  const match = { bracket: { $ne: null, $exists: true } };
  if (CITY_FILTER) match.city = CITY_FILTER;
  if (dateFrom) match.local_date = { $gte: dateFrom };
  return col
    .find(match, {
      projection: {
        city: 1,
        local_date: 1,
        bracket: 1,
        pacing_time: 1,
        captured_at: 1,
        yes_price_cents: 1,
      },
    })
    .toArray();
}

/** Collect winning_bracket per city|date from one collection into `into` Map. */
async function fetchWinners(col, dateFrom, into) {
  const match = { winning_bracket: { $ne: null, $exists: true } };
  if (CITY_FILTER) match.city = CITY_FILTER;
  if (dateFrom) match.local_date = { $gte: dateFrom };
  const rows = await col
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

// ---------------------------------------------------------------------------
// Per-bracket data building
// ---------------------------------------------------------------------------

/**
 * From raw tick documents, build a Map:
 *   "city|date" → { city, local_date, brackets: Map(bracket → { ticksPerHour, firstTick }) }
 *
 * ticksPerHour is a length-10 array indexed by pacing_time bucket (0=8am..9=5pm).
 * firstTick stores the earliest-captured_at tick's fields for first-tick signals.
 */
function buildBracketData(docs) {
  const data = new Map();
  for (const doc of docs) {
    const bracket = normBracket(doc.bracket);
    if (!bracket) continue;

    const cdKey = `${doc.city}|${doc.local_date}`;
    if (!data.has(cdKey)) {
      data.set(cdKey, {
        city: doc.city,
        local_date: doc.local_date,
        brackets: new Map(),
      });
    }
    const cd = data.get(cdKey);

    if (!cd.brackets.has(bracket)) {
      cd.brackets.set(bracket, {
        ticksPerHour: new Array(NUM_HOUR_BUCKETS).fill(0),
        firstTick: null,
        // First yes_price_cents seen within each hour bucket (by captured_at order)
        firstPricePerHour: new Array(NUM_HOUR_BUCKETS).fill(null),
        firstCapturedAtPerHour: new Array(NUM_HOUR_BUCKETS).fill(null),
      });
    }
    const br = cd.brackets.get(bracket);

    // Accumulate tick in its hour bucket
    const bucket = pacingTimeToBucket(doc.pacing_time);
    if (bucket !== null) {
      br.ticksPerHour[bucket]++;

      // Track first price seen in this hour bucket (earliest captured_at wins)
      if (
        typeof doc.yes_price_cents === "number" &&
        (br.firstCapturedAtPerHour[bucket] === null ||
          doc.captured_at < br.firstCapturedAtPerHour[bucket])
      ) {
        br.firstCapturedAtPerHour[bucket] = doc.captured_at;
        br.firstPricePerHour[bucket] = doc.yes_price_cents;
      }
    }

    // Track first tick by earliest captured_at (lexicographic ISO string compare)
    if (!br.firstTick || doc.captured_at < br.firstTick.captured_at) {
      br.firstTick = {
        captured_at: doc.captured_at,
        pacing_time: doc.pacing_time,
        yes_price_cents: typeof doc.yes_price_cents === "number" ? doc.yes_price_cents : null,
      };
    }
  }
  return data;
}

/**
 * Merge two bracketData maps (used for the "combined" method).
 * Tick counts are summed; the earlier first-tick (by captured_at) is kept.
 */
function mergeBracketData(mapA, mapB) {
  const merged = new Map();

  for (const [cdKey, cdA] of mapA) {
    merged.set(cdKey, {
      city: cdA.city,
      local_date: cdA.local_date,
      brackets: new Map(
        [...cdA.brackets.entries()].map(([b, brA]) => [
          b,
          {
            ticksPerHour: [...brA.ticksPerHour],
            firstTick: brA.firstTick,
            firstPricePerHour: [...brA.firstPricePerHour],
            firstCapturedAtPerHour: [...brA.firstCapturedAtPerHour],
          },
        ])
      ),
    });
  }

  for (const [cdKey, cdB] of mapB) {
    if (!merged.has(cdKey)) {
      merged.set(cdKey, {
        city: cdB.city,
        local_date: cdB.local_date,
        brackets: new Map(
          [...cdB.brackets.entries()].map(([b, brB]) => [
            b,
            {
              ticksPerHour: [...brB.ticksPerHour],
              firstTick: brB.firstTick,
              firstPricePerHour: [...brB.firstPricePerHour],
              firstCapturedAtPerHour: [...brB.firstCapturedAtPerHour],
            },
          ])
        ),
      });
      continue;
    }
    const cdM = merged.get(cdKey);
    for (const [b, brB] of cdB.brackets) {
      if (!cdM.brackets.has(b)) {
        cdM.brackets.set(b, {
          ticksPerHour: [...brB.ticksPerHour],
          firstTick: brB.firstTick,
          firstPricePerHour: [...brB.firstPricePerHour],
          firstCapturedAtPerHour: [...brB.firstCapturedAtPerHour],
        });
      } else {
        const brM = cdM.brackets.get(b);
        // Sum tick counts per hour bucket; keep earlier first price per hour
        for (let i = 0; i < NUM_HOUR_BUCKETS; i++) {
          brM.ticksPerHour[i] += brB.ticksPerHour[i];
          // Keep the earlier captured_at price for each hour bucket
          if (
            brB.firstCapturedAtPerHour[i] !== null &&
            (brM.firstCapturedAtPerHour[i] === null ||
              brB.firstCapturedAtPerHour[i] < brM.firstCapturedAtPerHour[i])
          ) {
            brM.firstCapturedAtPerHour[i] = brB.firstCapturedAtPerHour[i];
            brM.firstPricePerHour[i] = brB.firstPricePerHour[i];
          }
        }
        // Keep earlier first tick across both collections
        if (
          brB.firstTick &&
          (!brM.firstTick || brB.firstTick.captured_at < brM.firstTick.captured_at)
        ) {
          brM.firstTick = brB.firstTick;
        }
      }
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Feature doc construction
// ---------------------------------------------------------------------------

/**
 * Given a fully-built bracketData map and a winners map, produce an array of
 * feature documents ready to upsert into stats_features.
 */
function buildFeatureDocs(bracketData, winners, method, computedAt) {
  const docs = [];

  for (const [cdKey, cd] of bracketData) {
    const winningBracket = winners.get(cdKey) ?? null;
    const resolved = winningBracket !== null;

    const bracketsArr = [...cd.brackets.entries()]; // [[bracket, br], ...]

    // Pre-compute cumulative counts for all brackets at each hour window
    // cumByBracket[bracket][n] = sum of ticksPerHour[0..n]
    const cumByBracket = new Map();
    for (const [bracket, br] of bracketsArr) {
      const cum = new Array(NUM_HOUR_BUCKETS).fill(0);
      let running = 0;
      for (let n = 0; n < NUM_HOUR_BUCKETS; n++) {
        running += br.ticksPerHour[n];
        cum[n] = running;
      }
      cumByBracket.set(bracket, cum);
    }

    // For each hour window, build a sorted list of (bracket, count) to derive ranks
    // Stored as rankAtHour[n] = [[bracket, count], ...] sorted desc by count
    const rankAtHour = [];
    for (let n = 0; n < NUM_HOUR_BUCKETS; n++) {
      const sorted = bracketsArr
        .map(([b]) => [b, cumByBracket.get(b)[n]])
        .sort((a, b) => b[1] - a[1]);
      rankAtHour.push(sorted);
    }

    // Compute normalised lead margin per hour for this city-day.
    // lead_margin[n] = (rank1_ticks - rank2_ticks) / total_ticks_through_n
    // This is a city-day level signal (same value for every bracket on that day).
    const leadMarginThroughHour = new Array(NUM_HOUR_BUCKETS).fill(0);
    for (let n = 0; n < NUM_HOUR_BUCKETS; n++) {
      const sorted = rankAtHour[n];
      if (sorted.length === 0) continue;
      const totalTicks = sorted.reduce((s, [, c]) => s + c, 0);
      if (totalTicks === 0) continue;
      const rank1Count = sorted[0][1];
      const rank2Count = sorted.length > 1 ? sorted[1][1] : 0;
      leadMarginThroughHour[n] = (rank1Count - rank2Count) / totalTicks;
    }

    for (const [bracket, br] of bracketsArr) {
      const cum = cumByBracket.get(bracket);

      const tickCountThroughHour = cum;
      const rankThroughHour = new Array(NUM_HOUR_BUCKETS).fill(null);
      const isLeaderThroughHour = new Array(NUM_HOUR_BUCKETS).fill(false);

      for (let n = 0; n < NUM_HOUR_BUCKETS; n++) {
        const sorted = rankAtHour[n]; // [[bracket, count], ...]
        const myCount = cum[n];

        // Sequential rank (1-indexed position in sorted order)
        let rank = 1;
        for (const [b] of sorted) {
          if (b === bracket) {
            rankThroughHour[n] = rank;
            break;
          }
          rank++;
        }

        // is_leader: tied for the maximum cumulative count (and the max is > 0)
        const maxCount = sorted.length > 0 ? sorted[0][1] : 0;
        isLeaderThroughHour[n] = myCount > 0 && myCount === maxCount;
      }

      // First-tick signals
      const ft = br.firstTick;
      const firstTickPriceCents = ft?.yes_price_cents ?? null;
      const firstTickHour =
        ft?.pacing_time ? pacingTimeToBucket(ft.pacing_time) : null;
      const hasPrice = typeof firstTickPriceCents === "number";

      // Outcome
      const won = resolved ? bracket === winningBracket : null;
      // edge_cents: 100 - price if won, -price if lost (per $1 bet at first-tick entry price)
      const edgeCents =
        resolved && hasPrice && won !== null
          ? won
            ? 100 - firstTickPriceCents
            : -firstTickPriceCents
          : null;

      docs.push({
        city: cd.city,
        local_date: cd.local_date,
        bracket,
        method,
        first_tick_price_cents: firstTickPriceCents,
        first_tick_hour: firstTickHour,
        has_price: hasPrice,
        tick_count_through_hour: tickCountThroughHour,
        rank_through_hour: rankThroughHour,
        is_leader_through_hour: isLeaderThroughHour,
        // First yes_price_cents seen within each hour bucket for this bracket
        price_at_hour: br.firstPricePerHour,
        // Normalised leader gap: (rank1_ticks - rank2_ticks) / total_ticks per hour
        // Same for every bracket on the same city-day — measures market decisiveness
        lead_margin_through_hour: leadMarginThroughHour,
        final_tick_count: tickCountThroughHour[NUM_HOUR_BUCKETS - 1],
        final_rank: rankThroughHour[NUM_HOUR_BUCKETS - 1],
        resolved,
        won,
        edge_cents: edgeCents,
        computed_at: computedAt,
      });
    }
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log("Connected to MongoDB.");

  const db = client.db("weather");
  const linearCol = db.collection("high-temp");
  const reciprocalCol = db.collection("reciprocal");
  const featuresCol = db.collection("stats_features");

  // Ensure indexes (idempotent)
  if (!DRY_RUN) {
    await featuresCol.createIndex(
      { city: 1, local_date: 1, bracket: 1, method: 1 },
      { unique: true, name: "city_date_bracket_method_unique" }
    );
    await featuresCol.createIndex({ method: 1 }, { name: "method" });
    await featuresCol.createIndex({ local_date: 1 }, { name: "local_date" });
    await featuresCol.createIndex(
      { method: 1, city: 1, local_date: 1 },
      { name: "method_city_date" }
    );
    console.log("Indexes ensured.");
  }

  const dateFrom = buildDateFrom();
  if (dateFrom) {
    console.log(`Mode: incremental  --days=${DAYS}  dateFrom=${dateFrom}`);
  } else {
    console.log("Mode: full history  (--force)");
  }
  if (CITY_FILTER) console.log(`City filter: ${CITY_FILTER}`);
  if (DRY_RUN) console.log("DRY RUN — no writes.");

  const computedAt = new Date();

  // Fetch raw tick docs from both collections
  console.log("\nFetching ticks from high-temp...");
  const linearDocs = await fetchTicks(linearCol, dateFrom);
  console.log(`  ${linearDocs.length.toLocaleString()} docs`);

  console.log("Fetching ticks from reciprocal...");
  const reciprocalDocs = await fetchTicks(reciprocalCol, dateFrom);
  console.log(`  ${reciprocalDocs.length.toLocaleString()} docs`);

  // Fetch resolved outcomes from both collections (merge)
  console.log("Fetching resolved outcomes...");
  const winners = new Map();
  await fetchWinners(linearCol, dateFrom, winners);
  await fetchWinners(reciprocalCol, dateFrom, winners);
  console.log(`  ${winners.size.toLocaleString()} resolved city-dates`);

  // Build per-bracket data for each method
  console.log("\nBuilding bracket data structures...");
  const linearData = buildBracketData(linearDocs);
  const reciprocalData = buildBracketData(reciprocalDocs);
  const combinedData = mergeBracketData(linearData, reciprocalData);
  console.log(
    `  linear: ${linearData.size} city-dates, reciprocal: ${reciprocalData.size} city-dates, combined: ${combinedData.size} city-dates`
  );

  const methods = [
    { method: "linear", data: linearData },
    { method: "reciprocal", data: reciprocalData },
    { method: "combined", data: combinedData },
  ];

  let totalDocs = 0;
  for (const { method, data } of methods) {
    console.log(`\nBuilding feature docs for method=${method}...`);
    const docs = buildFeatureDocs(data, winners, method, computedAt);
    console.log(`  ${docs.length.toLocaleString()} feature docs`);
    totalDocs += docs.length;

    if (DRY_RUN) continue;

    // Upsert in batches
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);
      const ops = batch.map((doc) => ({
        replaceOne: {
          filter: {
            city: doc.city,
            local_date: doc.local_date,
            bracket: doc.bracket,
            method: doc.method,
          },
          replacement: doc,
          upsert: true,
        },
      }));
      await featuresCol.bulkWrite(ops, { ordered: false });
      process.stdout.write(`  upserted ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length}\r`);
    }
    console.log(`  Done.${" ".repeat(20)}`);
  }

  console.log(
    `\nComplete. Total feature docs: ${totalDocs.toLocaleString()}. computed_at: ${computedAt.toISOString()}`
  );
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
