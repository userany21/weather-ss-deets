#!/usr/bin/env node
/**
 * backfill-winning-outcomes.js
 *
 * For every distinct (city, local_date) pair in weather.high-temp, looks up
 * the corresponding Polymarket daily-high event, and — if it has resolved —
 * tags EVERY tick document for that city+day with the winning bracket in a
 * single updateMany. Does NOT hit Polymarket once per tick; hits it once per
 * unique day-market, since the outcome is the same for all of that day's ticks.
 *
 * Idempotent: skips any (city, local_date) whose docs already have
 * winning_bracket set, so it's safe to re-run periodically to pick up
 * markets that have since resolved.
 *
 * Usage:
 *   MONGO_URI="mongodb+srv://..." node backfill-winning-outcomes.js
 *
 * Requires Node 18+ (built-in fetch).
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function buildEventSlug(city, isoDate) {
  const citySlug = city.toLowerCase().replace(/\s+/g, '-');
  const [year, month, day] = isoDate.split('-').map(Number);
  const monthName = MONTH_NAMES[month - 1];
  return `highest-temperature-in-${citySlug}-on-${monthName}-${day}-${year}`;
}

// Parses a bracket title into { type, low, high } — same shape used by the
// live n8n workflow's price-check node.
function parseBracket(market) {
  const title = market.groupItemTitle;
  if (title.includes('or below')) {
    const num = parseInt(title.match(/-?\d+/)[0], 10);
    return { type: 'below', low: -Infinity, high: num };
  }
  if (title.includes('or higher')) {
    const num = parseInt(title.match(/-?\d+/)[0], 10);
    return { type: 'above', low: num, high: Infinity };
  }
  const rangeMatch = title.match(/(\d+)\s*-\s*(\d+)/);
  if (rangeMatch) {
    return { type: 'range', low: parseInt(rangeMatch[1], 10), high: parseInt(rangeMatch[2], 10) };
  }
  const num = parseInt(title.match(/-?\d+/)[0], 10);
  return { type: 'exact', low: num, high: num };
}

// Finds the winning market in an event, if any.
// Treats the highest Yes price as settled once it is >= 0.995 — Polymarket
// often pins the book there (UI shows 100%) before closing the event or
// printing an official 1.0.
function findWinningMarket(event) {
  if (!event || !event.markets) return null;

  let best = null;
  let bestPrice = -1;
  for (const market of event.markets) {
    let outcomes, outcomePrices;
    try {
      outcomes = JSON.parse(market.outcomes);
      outcomePrices = JSON.parse(market.outcomePrices);
    } catch {
      continue;
    }
    const yesIndex = outcomes.indexOf('Yes');
    if (yesIndex === -1) continue;
    const price = parseFloat(outcomePrices[yesIndex]);
    if (!Number.isNaN(price) && price > bestPrice) {
      bestPrice = price;
      best = market;
    }
  }
  return bestPrice >= 0.995 ? best : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('Missing MONGO_URI in environment (.env)');
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const collection = client.db('weather').collection('high-temp');

  // Only look at day-markets that don't already have an outcome tagged.
  const pending = await collection.aggregate([
    { $match: { winning_bracket: { $exists: false } } },
    { $group: { _id: { city: '$city', local_date: '$local_date' } } },
  ]).toArray();

  console.log(`Found ${pending.length} city-day markets without a tagged outcome.`);

  let resolvedCount = 0;
  let stillOpenCount = 0;
  let notFoundCount = 0;
  let updatedDocs = 0;

  for (const { _id: { city, local_date } } of pending) {
    const slug = buildEventSlug(city, local_date);

    let event;
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/events/slug/${slug}`);
      if (!res.ok) {
        notFoundCount++;
        console.log(`  - ${city} ${local_date}: event not found (${res.status}) for slug "${slug}"`);
        await sleep(250);
        continue;
      }
      event = await res.json();
      if (Array.isArray(event)) event = event[0];
    } catch (err) {
      console.log(`  - ${city} ${local_date}: fetch failed — ${err.message}`);
      await sleep(250);
      continue;
    }

    const winner = event && findWinningMarket(event);
    if (!winner) {
      stillOpenCount++;
      await sleep(250);
      continue;
    }

    const bounds = parseBracket(winner);
    const result = await collection.updateMany(
      { city, local_date },
      {
        $set: {
          winning_bracket: winner.groupItemTitle,
          winning_bracket_low: bounds.low,
          winning_bracket_high: bounds.high,
          outcome_checked_at: new Date().toISOString(),
        },
      }
    );

    resolvedCount++;
    updatedDocs += result.modifiedCount;
    console.log(`  - ${city} ${local_date}: WON "${winner.groupItemTitle}" — tagged ${result.modifiedCount} docs`);

    await sleep(250); // be polite to the API
  }

  console.log('---');
  console.log(`Resolved and tagged: ${resolvedCount} markets (${updatedDocs} documents updated)`);
  console.log(`Still open / no clean winner: ${stillOpenCount}`);
  console.log(`Event not found: ${notFoundCount}`);

  await client.close();
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});