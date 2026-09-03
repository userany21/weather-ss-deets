#!/usr/bin/env node
/**
 * migrate-history-to-mongo.js
 *
 * One-time backfill: reads the exported "weather-weightavg-clob" Data Table
 * CSV (columns: id, city, date, history, unit, createdAt, updatedAt) and
 * explodes each row's stringed-together `history` field into one MongoDB
 * document per tick — matching the schema the n8n workflow now writes
 * going forward (weather.high-temp collection).
 *
 * history string example:
 *   "29.6C (11:00am, 0¢) -> 30.4C (12:00pm, 38¢)"
 *   "20C (1:55pm, 85¢↑) -> 19.8C (2:25pm, 91¢↑)"
 *
 * WEST-COAST DAY-BOUNDARY FIX
 * ----------------------------
 * For Los Angeles / Seattle / San Francisco, the old workflow stamped each
 * row's `date` using UTC, but scanned on LOCAL time (8am-6pm). Since Pacific
 * local afternoon crosses UTC midnight, a row's history string often starts
 * with a short leftover run of evening ticks (~5-7pm) that actually belong
 * to the PREVIOUS local day, followed by that day's own real ticks starting
 * back at ~8am. Example (San Francisco, row dated 2026-09-02):
 *
 *   69.8F (5:03pm...) -> 71.2F (5:45pm...)   <- actually Sept 1's tail
 *   72.9F (8:15am...) -> 71.5F (5:00pm...)   <- Sept 2's real data
 *
 * This script detects that seam (a tick at >=3pm immediately followed by a
 * tick at <=noon) and reassigns everything before the seam to (row date - 1
 * day). Everything from the seam onward keeps the row's own date.
 *
 * Usage:
 *   npm install csv-parse mongodb dotenv
 *   MONGO_URI="mongodb+srv://..." node migrate-history-to-mongo.js "8-26 to 8-31.csv"
 *
 * Reads MONGO_URI from a .env file if present (matches the WETHR_EMAIL /
 * WETHR_PASSWORD / DISCORD_WEBHOOK_URL pattern already in this repo's
 * .env.example).
 */

require('dotenv').config();
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { MongoClient } = require('mongodb');

// City -> IANA timezone. Extend this if new cities show up in the roster.
const CITY_TIMEZONES = {
  'los angeles': 'America/Los_Angeles',
  'seattle': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  'houston': 'America/Chicago',
  'nyc': 'America/New_York',
  'new york': 'America/New_York',
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

// Only these cities' scan windows straddle the UTC-date rollover.
const WEST_COAST_CITIES = new Set(['los angeles', 'seattle', 'san francisco']);

// Matches one history entry: temp, unit, time, and an OPTIONAL price+arrow
// (some ticks were logged with no price at all, e.g. "81.2F (12:37pm)").
const ENTRY_REGEX = /([\d.]+)([CF])\s*\(([^,)]+)(?:,\s*(\d+)¢(↑|↓)?)?\)/g;

function normalizeTime(raw) {
  // "11:00am" -> "11:00 AM"; "6pm" -> "6:00 PM" (some entries omit minutes)
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!m) return raw.trim();
  const [, h, min, ap] = m;
  return `${h}:${min || '00'} ${ap.toUpperCase()}`;
}

function to24Hour(timeStr) {
  const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && hour !== 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;
  return hour;
}

function toIsoDate(dateStr) {
  const trimmed = (dateStr || '').trim();

  // already ISO: "2026-08-26"
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // US format: "8/26/2026"
  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  throw new Error(`Unrecognized date format: "${dateStr}"`);
}

function shiftDate(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// Finds the index of the first tick that belongs to the row's own date.
// Everything before that index is a leftover evening run from the prior day.
// Returns 0 if no such seam is found (nothing to shift).
function findDayBoundary(ticks) {
  for (let i = 1; i < ticks.length; i++) {
    const prevHour = to24Hour(ticks[i - 1].pacing_time);
    const curHour = to24Hour(ticks[i].pacing_time);
    if (prevHour >= 15 && curHour <= 12) {
      return i;
    }
  }
  return 0;
}

// Given an ISO date ("2026-09-02"), a local time ("11:00 AM"), and an IANA
// timezone, produce a real UTC ISO timestamp — no moment/luxon dependency.
function toCapturedAt(isoDateStr, timeStr, tz) {
  const [year, month, day] = isoDateStr.split('-').map(Number);
  const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && hour !== 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;

  const naiveUTC = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (isNaN(naiveUTC.getTime())) {
    throw new Error(`Could not build a valid date from isoDateStr="${isoDateStr}" timeStr="${timeStr}"`);
  }
  const tzString = naiveUTC.toLocaleString('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const tzDate = new Date(tzString.replace(
    /(\d+)\/(\d+)\/(\d+),? (\d+):(\d+):(\d+)/, '$3-$1-$2T$4:$5:$6Z'
  ));
  const offsetMs = tzDate.getTime() - naiveUTC.getTime();
  return new Date(naiveUTC.getTime() - offsetMs).toISOString();
}

function parseHistory(historyStr) {
  if (!historyStr || historyStr.trim().toLowerCase() === 'null') return [];
  const entries = [];
  let match;
  ENTRY_REGEX.lastIndex = 0;
  while ((match = ENTRY_REGEX.exec(historyStr)) !== null) {
    const [, temp, unit, rawTime, priceCents] = match;
    entries.push({
      weighted_avg: parseFloat(temp),
      unit,
      pacing_time: normalizeTime(rawTime),
      yes_price_cents: priceCents ? parseInt(priceCents, 10) : null,
      yes_price: priceCents ? parseInt(priceCents, 10) / 100 : null,
    });
  }
  return entries;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node migrate-history-to-mongo.js <path-to-csv>');
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('Missing MONGO_URI in environment (.env)');
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });

  const docs = [];
  const skipped = [];
  let boundariesFixed = 0;

  for (const row of rows) {
    const city = row.city?.trim().toLowerCase();
    const tz = CITY_TIMEZONES[city];
    if (!tz) {
      skipped.push({ row, reason: `no timezone mapping for city "${city}"` });
      continue;
    }

    const ticks = parseHistory(row.history);
    if (ticks.length === 0) {
      skipped.push({ row, reason: 'no parseable history (null/empty)' });
      continue;
    }

    const isoDate = toIsoDate(row.date);
    let boundaryIdx = 0;
    if (WEST_COAST_CITIES.has(city)) {
      boundaryIdx = findDayBoundary(ticks);
      if (boundaryIdx > 0) boundariesFixed++;
    }

    ticks.forEach((tick, i) => {
      const tickDate = i < boundaryIdx ? shiftDate(isoDate, -1) : isoDate;
      let capturedAt;
      try {
        capturedAt = toCapturedAt(tickDate, tick.pacing_time, tz);
      } catch (err) {
        throw new Error(
          `Failed on row city="${row.city}" date="${row.date}" tick.pacing_time="${tick.pacing_time}": ${err.message}`
        );
      }
      docs.push({
        city,
        local_date: tickDate,
        pacing_time: tick.pacing_time,
        unit: tick.unit,
        weighted_avg: tick.weighted_avg,
        bracket: null, // not recoverable from the old blob format
        yes_price: tick.yes_price,
        yes_price_cents: tick.yes_price_cents,
        captured_at: capturedAt,
        backfilled: true, // lets you tell reconstructed docs apart from live ones
      });
    });
  }

  console.log(`Parsed ${docs.length} tick documents from ${rows.length} CSV rows.`);
  console.log(`West-coast day-boundary fix applied to ${boundariesFixed} rows.`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} rows (no data or unmapped city):`);
    skipped.forEach(s => console.log(`  - ${s.row.city} ${s.row.date}: ${s.reason}`));
  }

  if (docs.length === 0) {
    console.log('Nothing to insert.');
    return;
  }

  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db('weather');
    const collection = db.collection('high-temp');
    const result = await collection.insertMany(docs, { ordered: false });
    console.log(`Inserted ${result.insertedCount} documents into weather.high-temp.`);
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});