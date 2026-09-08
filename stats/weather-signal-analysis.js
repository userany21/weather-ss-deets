/**
 * weather-signal-analysis.js
 *
 * Answers three questions from the high-temp / reciprocal MongoDB collections:
 *
 *   1. On average, what hour-of-day (since market open) has the best edge
 *      (outcome - yes_price) for buying, overall and per city?
 *   2. When linear and reciprocal disagree on point_bracket, which one is
 *      right more often — overall and per city?
 *   3. Per city, which method (linear or reciprocal) has better day-wide
 *      accuracy (not just the final tick)?
 *
 * Requires: npm install mongodb dotenv
 * Env: MONGODB_URI (connection string), MONGODB_DB (default "weather")
 *
 * NOTE: paced_at / point_bracket logic below is a direct port of the
 * algorithm you described from weather-transform.ts. If your real
 * enrichDay() formats point_bracket labels differently (e.g. rounding,
 * or single-degree vs range formatting), the string comparisons against
 * winning_bracket will silently mismatch. Worth spot-checking a few days
 * of output against your dashboard before trusting the numbers.
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGODB_DB || 'weather';

// ---------- Ported transform logic ----------

function parseMinutesSinceMidnight(pacingTime) {
  // "10:15 AM" -> minutes since midnight
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((pacingTime || '').trim());
  if (!m) return null;
  let [, hh, mm, ap] = m;
  hh = parseInt(hh, 10);
  mm = parseInt(mm, 10);
  if (/PM/i.test(ap) && hh !== 12) hh += 12;
  if (/AM/i.test(ap) && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function computePacedAtSeries(ticksSortedByCapturedAt, localDate) {
  let dayOffset = 0;
  let prevMins = null;
  const dayStartMs = Date.parse(`${localDate}T00:00:00Z`);
  return ticksSortedByCapturedAt.map((t) => {
    const mins = parseMinutesSinceMidnight(t.pacing_time);
    if (mins == null) return { ...t, paced_at: null };
    if (prevMins != null && prevMins - mins > 12 * 60) {
      dayOffset += 1;
    }
    prevMins = mins;
    const paced_at = dayStartMs + dayOffset * 86400000 + mins * 60000;
    return { ...t, paced_at };
  });
}

function computePointBracket(temp, unit, winningLow, winningHigh) {
  if (temp == null) return null;
  let anchor, width;
  if (winningLow != null && winningHigh != null && Number.isFinite(winningLow) && Number.isFinite(winningHigh)) {
    anchor = Math.trunc(winningLow);
    width = Math.trunc(winningHigh - winningLow) + 1;
  } else {
    anchor = 0;
    width = unit === 'C' ? 1 : 2;
  }
  const low = anchor + width * Math.floor((temp - anchor) / width);
  const high = low + width - 1;
  const unitLabel = unit ? `\u00B0${unit}` : '';
  return width === 1 ? `${low}${unitLabel}` : `${low}-${high}${unitLabel}`;
}

// ---------- Stat accumulators ----------

function bump(store, key, method, val) {
  if (!store[key]) store[key] = { linear: { sum: 0, count: 0 }, reciprocal: { sum: 0, count: 0 } };
  store[key][method].sum += val;
  store[key][method].count += 1;
}

function avg(bucket) {
  return bucket.count ? bucket.sum / bucket.count : null;
}

// ---------- Main ----------

async function main() {
  if (!MONGODB_URI) {
    console.error('Set MONGODB_URI in your environment or a .env file.');
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const highTempCol = db.collection('high-temp');
  const reciprocalCol = db.collection('reciprocal');

  const settledDays = await highTempCol
    .aggregate([
      { $match: { winning_bracket: { $exists: true, $ne: null } } },
      { $group: { _id: { city: '$city', local_date: '$local_date' } } },
    ])
    .toArray();

  console.log(`Found ${settledDays.length} settled city-days.`);

  // --- One-time sanity check: does our computed label actually match the stored format? ---
  let debugPrinted = false;

  const hourlyEdge = {};              // key: hourBucket
  const cityHourlyEdge = {};          // key: "city|hourBucket"
  const disagreement = {};            // key: city
  const cityAccuracy = {};            // key: city
  const cityHourExamples = {};        // key: "city|hourBucket|method" -> array of example rows

  for (const { _id: { city, local_date } } of settledDays) {
    const [linearRaw, reciprocalRaw] = await Promise.all([
      highTempCol.find({ city, local_date }).sort({ captured_at: 1 }).toArray(),
      reciprocalCol.find({ city, local_date }).sort({ captured_at: 1 }).toArray(),
    ]);
    if (!linearRaw.length) continue;

    const winningRow = linearRaw.find((t) => t.winning_bracket_low != null && t.winning_bracket_high != null);
    if (!winningRow) continue;
    const { winning_bracket, winning_bracket_low, winning_bracket_high } = winningRow;

    const linearTicks = computePacedAtSeries(linearRaw, local_date).map((t) => ({
      ...t,
      point_bracket: computePointBracket(t.weighted_avg, t.unit, winning_bracket_low, winning_bracket_high),
    }));
    const reciprocalTicks = computePacedAtSeries(reciprocalRaw, local_date).map((t) => ({
      ...t,
      point_bracket: computePointBracket(t.weighted_avg, t.unit, winning_bracket_low, winning_bracket_high),
    }));

    if (!linearTicks[0] || linearTicks[0].paced_at == null) continue;
    // Fixed anchor: 8am local, not "whenever the first tick of the day happened to land."
    // This keeps hour buckets meaning the same thing on every day, even if the scraper
    // started late or had a gap on a particular day.
    const dayStart = Date.parse(`${local_date}T00:00:00Z`) + 8 * 3600000;
    const firstTickPacing = linearTicks[0].pacing_time; // kept only as a diagnostic, not used for bucketing

    if (!debugPrinted) {
      const sample = linearTicks.find((t) => t.point_bracket != null);
      if (sample) {
        console.log('\n--- FORMAT SANITY CHECK (first sample) ---');
        console.log('stored winning_bracket:   ', JSON.stringify(winning_bracket));
        console.log('computed point_bracket:   ', JSON.stringify(sample.point_bracket));
        console.log('weighted_avg / unit:      ', sample.weighted_avg, sample.unit);
        console.log('winning_bracket_low/high: ', winning_bracket_low, winning_bracket_high);
        console.log(
          sample.point_bracket === winning_bracket || true
            ? 'If these two strings don\'t look identical in format, fix computePointBracket before trusting any stats below.'
            : ''
        );
        console.log('-------------------------------------------\n');
        debugPrinted = true;
      }
    }

    if (!cityAccuracy[city]) {
      cityAccuracy[city] = { linear: { matches: 0, total: 0 }, reciprocal: { matches: 0, total: 0 } };
    }

    const processMethod = (method, ticks) => {
      for (const t of ticks) {
        if (t.weighted_avg == null || t.yes_price == null || t.paced_at == null) continue;
        const hourBucket = Math.floor((t.paced_at - dayStart) / 3600000);
        const outcome = t.point_bracket === winning_bracket ? 1 : 0;
        const edge = outcome - t.yes_price;

        bump(hourlyEdge, hourBucket, method, edge);
        bump(cityHourlyEdge, `${city}|${hourBucket}`, method, edge);

        cityAccuracy[city][method].total += 1;
        cityAccuracy[city][method].matches += outcome;

        const exKey = `${city}|${hourBucket}|${method}`;
        if (!cityHourExamples[exKey]) cityHourExamples[exKey] = [];
        cityHourExamples[exKey].push({
          method,
          local_date,
          first_tick_pacing: firstTickPacing,
          pacing_time: t.pacing_time,
          weighted_avg: t.weighted_avg,
          unit: t.unit,
          point_bracket: t.point_bracket,
          winning_bracket,
          hit: outcome === 1 ? 'YES' : 'no',
          yes_price: t.yes_price,
          edge: Number(edge.toFixed(4)),
        });
      }
    };

    processMethod('linear', linearTicks);
    processMethod('reciprocal', reciprocalTicks);

    // Disagreement tiebreaker: pair ticks by pacing_time within the same city-day
    if (!disagreement[city]) {
      disagreement[city] = { total: 0, linearRight: 0, reciprocalRight: 0, bothRight: 0, bothWrong: 0 };
    }
    const reciprocalByPacing = new Map(reciprocalTicks.map((t) => [t.pacing_time, t]));
    for (const lt of linearTicks) {
      const rt = reciprocalByPacing.get(lt.pacing_time);
      if (!rt || lt.point_bracket == null || rt.point_bracket == null) continue;
      if (lt.point_bracket === rt.point_bracket) continue; // they agree, not a tiebreak case

      disagreement[city].total += 1;
      const lRight = lt.point_bracket === winning_bracket;
      const rRight = rt.point_bracket === winning_bracket;
      if (lRight && rRight) disagreement[city].bothRight += 1;
      else if (lRight) disagreement[city].linearRight += 1;
      else if (rRight) disagreement[city].reciprocalRight += 1;
      else disagreement[city].bothWrong += 1;
    }
  }

  // ---------- Reports ----------

  console.log('\n=== Average edge (outcome - yes_price) by hour since market open, ALL CITIES ===');
  const hourRows = Object.keys(hourlyEdge)
    .map(Number)
    .sort((a, b) => a - b)
    .map((h) => ({
      hour: h,
      linear_edge: avg(hourlyEdge[h].linear)?.toFixed(4),
      linear_n: hourlyEdge[h].linear.count,
      reciprocal_edge: avg(hourlyEdge[h].reciprocal)?.toFixed(4),
      reciprocal_n: hourlyEdge[h].reciprocal.count,
    }));
  console.table(hourRows);

  console.log('\n=== Best hour bucket per city (by linear edge, min 5 samples) ===');
  const cityBestHour = {};
  for (const key of Object.keys(cityHourlyEdge)) {
    const [city, hourStr] = key.split('|');
    const hour = Number(hourStr);
    const bucket = cityHourlyEdge[key];
    const lAvg = avg(bucket.linear);
    const rAvg = avg(bucket.reciprocal);
    if (!cityBestHour[city]) cityBestHour[city] = { bestLinear: null, bestReciprocal: null };
    if (lAvg != null && bucket.linear.count >= 5) {
      if (!cityBestHour[city].bestLinear || lAvg > cityBestHour[city].bestLinear.edge) {
        cityBestHour[city].bestLinear = { hour, edge: lAvg, n: bucket.linear.count };
      }
    }
    if (rAvg != null && bucket.reciprocal.count >= 5) {
      if (!cityBestHour[city].bestReciprocal || rAvg > cityBestHour[city].bestReciprocal.edge) {
        cityBestHour[city].bestReciprocal = { hour, edge: rAvg, n: bucket.reciprocal.count };
      }
    }
  }
  console.table(
    Object.entries(cityBestHour).map(([city, v]) => ({
      city,
      best_hour_linear: v.bestLinear?.hour ?? '-',
      linear_edge: v.bestLinear?.edge?.toFixed(4) ?? '-',
      best_hour_reciprocal: v.bestReciprocal?.hour ?? '-',
      reciprocal_edge: v.bestReciprocal?.edge?.toFixed(4) ?? '-',
    }))
  );

  console.log('\n=== Examples backing each city\'s best linear hour ===');
  console.log('(most recent 5 ticks that landed in that city\'s best hour bucket, so you can eyeball whether the stat holds up)');
  for (const [city, v] of Object.entries(cityBestHour)) {
    if (!v.bestLinear) continue;
    const exKey = `${city}|${v.bestLinear.hour}|linear`;
    const examples = (cityHourExamples[exKey] || [])
      .slice()
      .sort((a, b) => (a.local_date < b.local_date ? 1 : -1))
      .slice(0, 5);
    if (!examples.length) continue;
    console.log(`\n-- ${city} — hour ${v.bestLinear.hour}, avg edge ${v.bestLinear.edge.toFixed(4)} over ${v.bestLinear.n} ticks --`);
    console.table(examples);
  }

  console.log('\n=== Disagreement tiebreaker (when point_bracket differs) ===');
  console.table(
    Object.entries(disagreement).map(([city, d]) => ({
      city,
      disagreements: d.total,
      linear_right_pct: d.total ? ((d.linearRight / d.total) * 100).toFixed(1) : '-',
      reciprocal_right_pct: d.total ? ((d.reciprocalRight / d.total) * 100).toFixed(1) : '-',
      both_right_pct: d.total ? ((d.bothRight / d.total) * 100).toFixed(1) : '-',
      both_wrong_pct: d.total ? ((d.bothWrong / d.total) * 100).toFixed(1) : '-',
    }))
  );

  console.log('\n=== Day-wide accuracy per city (fraction of ALL ticks matching winning bracket) ===');
  console.table(
    Object.entries(cityAccuracy).map(([city, a]) => ({
      city,
      linear_pct: a.linear.total ? ((a.linear.matches / a.linear.total) * 100).toFixed(1) : '-',
      linear_n: a.linear.total,
      reciprocal_pct: a.reciprocal.total ? ((a.reciprocal.matches / a.reciprocal.total) * 100).toFixed(1) : '-',
      reciprocal_n: a.reciprocal.total,
      preferred_method:
        a.linear.total && a.reciprocal.total
          ? a.linear.matches / a.linear.total > a.reciprocal.matches / a.reciprocal.total
            ? 'linear'
            : 'reciprocal'
          : '-',
    }))
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});