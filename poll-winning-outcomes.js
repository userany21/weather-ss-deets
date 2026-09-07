#!/usr/bin/env node
/**
 * poll-winning-outcomes.js
 *
 * Run this hourly via cron (every hour, all day — the script itself decides
 * which cities are actually "in window" this run).
 *
 * For each city, computes that city's OWN current local hour. Only acts on
 * cities where local time is 7pm-11pm (checks that day's market) or exactly
 * midnight (last chance — checks YESTERDAY's market, since local date has
 * just rolled over).
 *
 * Resolution logic per check:
 *   - Winner is whichever market has the highest Yes price, as soon as that
 *     price is >= 0.995. Polymarket often pins the book at 0.999 / 0.9995
 *     (UI shows 100%) hours before it prints an official 1.0 or closes the
 *     event — we treat that as settled. Tagged identically to a real
 *     resolution.
 *
 * Already-resolved (city, local_date) pairs are skipped immediately, so a
 * city that resolves at 8pm doesn't get re-checked every hour until midnight.
 *
 * A day that STILL hasn't hit 0.995 by midnight is left untouched by this
 * script (it only runs in the 7pm-midnight window) — run
 * backfill-winning-outcomes.js periodically as a catch-all for those rare
 * stragglers that take longer than a day to settle.
 *
 * Crontab (every hour, on the hour):
 *   0 * * * * cd /root/weather-ss-deets && /usr/bin/node poll-winning-outcomes.js >> poll-winning-outcomes.log 2>&1
 *
 * Requires Node 18+ (built-in fetch).
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const CITY_TIMEZONES = {
  'los angeles': 'America/Los_Angeles',
  'seattle': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  'houston': 'America/Chicago',
  'nyc': 'America/New_York',
  'atlanta': 'America/New_York',
  'miami': 'America/New_York',
  'hong kong': 'Asia/Hong_Kong',
  'beijing': 'Asia/Shanghai',
  'shanghai': 'Asia/Shanghai',
  'shenzhen': 'Asia/Shanghai',
  'tokyo': 'Asia/Tokyo',
  'seoul': 'Asia/Seoul',
  'singapore': 'Asia/Singapore',
  'wellington': 'Pacific/Auckland',
  'amsterdam': 'Europe/Amsterdam',
  'london': 'Europe/London',
  'madrid': 'Europe/Madrid',
  'milan': 'Europe/Rome',
  'munich': 'Europe/Berlin',
  'paris': 'Europe/Paris',
};

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function buildEventSlug(city, isoDate) {
  const citySlug = city.toLowerCase().replace(/\s+/g, '-');
  const [year, month, day] = isoDate.split('-').map(Number);
  return `highest-temperature-in-${citySlug}-on-${MONTH_NAMES[month - 1]}-${day}-${year}`;
}

function shiftDate(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// Structured (no regex-on-locale-string) local hour + date for a timezone.
function getLocalHourAndDate(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some ICU builds render midnight as "24"
  return { hour, isoDate: `${get('year')}-${get('month')}-${get('day')}` };
}

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

function yesPrice(market) {
  try {
    const outcomes = JSON.parse(market.outcomes);
    const outcomePrices = JSON.parse(market.outcomePrices);
    const yesIndex = outcomes.indexOf('Yes');
    if (yesIndex === -1) return null;
    return parseFloat(outcomePrices[yesIndex]);
  } catch {
    return null;
  }
}

function findExactWinner(markets) {
  for (const market of markets) {
    if (yesPrice(market) === 1) return market;
  }
  return null;
}

function findFallbackWinner(markets, threshold = 0.995) {
  let best = null;
  let bestPrice = -1;
  for (const market of markets) {
    const price = yesPrice(market);
    if (price !== null && price > bestPrice) {
      bestPrice = price;
      best = market;
    }
  }
  return bestPrice >= threshold ? best : null;
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('Missing MONGO_URI in environment (.env)');
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const collection = client.db('weather').collection('high-temp');

  const timestamp = new Date().toISOString();
  console.log(`--- poll-winning-outcomes run at ${timestamp} ---`);

  for (const [city, tz] of Object.entries(CITY_TIMEZONES)) {
    const { hour, isoDate } = getLocalHourAndDate(tz);

    let dateToCheck, isFinalCheck;
    if (hour >= 19 && hour <= 23) {
      dateToCheck = isoDate;
      isFinalCheck = false;
    } else if (hour === 0) {
      dateToCheck = shiftDate(isoDate, -1); // local date just rolled over; check the day that ended
      isFinalCheck = true;
    } else {
      continue; // outside this city's 7pm-midnight window right now
    }

    const already = await collection.findOne({
      city, local_date: dateToCheck, winning_bracket: { $exists: true },
    });
    if (already) continue; // already resolved, nothing to do

    const slug = buildEventSlug(city, dateToCheck);
    let event;
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/events/slug/${slug}`);
      if (!res.ok) {
        console.log(`  - ${city} ${dateToCheck}: event not found (${res.status})`);
        continue;
      }
      event = await res.json();
      if (Array.isArray(event)) event = event[0];
    } catch (err) {
      console.log(`  - ${city} ${dateToCheck}: fetch failed — ${err.message}`);
      continue;
    }
    if (!event || !event.markets) continue;

    const winner = findExactWinner(event.markets)
      || findFallbackWinner(event.markets, 0.995);
    if (!winner) {
      console.log(`  - ${city} ${dateToCheck}: no winner yet (local hour ${hour}${isFinalCheck ? ', final check' : ''})`);
      continue;
    }

    const bounds = parseBracket(winner);
    const result = await collection.updateMany(
      { city, local_date: dateToCheck },
      {
        $set: {
          winning_bracket: winner.groupItemTitle,
          winning_bracket_low: bounds.low,
          winning_bracket_high: bounds.high,
          outcome_checked_at: new Date().toISOString(),
        },
      }
    );
    console.log(`  - ${city} ${dateToCheck}: WON "${winner.groupItemTitle}" — tagged ${result.modifiedCount} docs`);
  }

  await client.close();
}

main().catch(err => {
  console.error('Poll failed:', err);
  process.exit(1);
});