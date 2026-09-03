// asia-poll.js
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { DateTime } = require('luxon');

const ASIA_CITIES = [
  { slug: 'hongkongobs', label: 'hong kong', tz: 'Asia/Hong_Kong', cadenceMinutes: 10, tickOffsetMinutes: 9 },
  { slug: 'beijing',     label: 'beijing',   tz: 'Asia/Shanghai',  cadenceMinutes: 30, tickOffsetMinutes: 0 },
  { slug: 'shanghai',    label: 'shanghai',  tz: 'Asia/Shanghai',  cadenceMinutes: 30, tickOffsetMinutes: 0 },
  { slug: 'shenzhen',    label: 'shenzhen',  tz: 'Asia/Shanghai',  cadenceMinutes: 60, tickOffsetMinutes: 0 },
  { slug: 'tokyo',       label: 'tokyo',     tz: 'Asia/Tokyo',     cadenceMinutes: 30, tickOffsetMinutes: 0 },
  { slug: 'seoul',       label: 'seoul',     tz: 'Asia/Seoul',     cadenceMinutes: 30, tickOffsetMinutes: 0 },
  { slug: 'singapore',   label: 'singapore', tz: 'Asia/Singapore', cadenceMinutes: 30, tickOffsetMinutes: 0 }
];

const UNIT = 'C';

const START_HOUR = 8;
const END_HOUR = 18;

const STATE_PATH = path.join(__dirname, 'state-asia.json');
const OUT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const LOCK_PATH = path.join(__dirname, '.asia-poll.lock');

if (fs.existsSync(LOCK_PATH)) {
  const lockAge = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
  const STALE_LOCK_MS = 10 * 60 * 1000;

  if (lockAge < STALE_LOCK_MS) {
    console.log('Previous run still in progress (lock held), skipping this poll.');
    process.exit(0);
  } else {
    console.log('Stale lock found (>10min old), previous run likely crashed — clearing it and proceeding.');
  }
}

fs.writeFileSync(LOCK_PATH, String(process.pid));

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// all valid tick DateTimes for this city, today, between 8am-6pm local
function getTicksForDay(dayStartLocal, cadenceMinutes, tickOffsetMinutes) {
  const windowStart = dayStartLocal.set({ hour: START_HOUR, minute: 0, second: 0, millisecond: 0 });
  const windowEnd = dayStartLocal.set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
  const ticks = [];

  for (let hour = START_HOUR; hour < END_HOUR; hour++) {
    for (let m = tickOffsetMinutes % cadenceMinutes; m < 60; m += cadenceMinutes) {
      const t = dayStartLocal.set({ hour, minute: m, second: 0, millisecond: 0 });
      if (t >= windowStart && t < windowEnd) ticks.push(t);
    }
  }
  return ticks.sort((a, b) => a.toMillis() - b.toMillis());
}

// the next tick target: whichever comes first at/after "now" (or at/after 8am if now is before 8am)
function computeNextTarget(nowLocal, cadenceMinutes, tickOffsetMinutes) {
  const dayStart = nowLocal.startOf('day');
  const ticks = getTicksForDay(dayStart, cadenceMinutes, tickOffsetMinutes);
  const windowStart = dayStart.set({ hour: START_HOUR, minute: 0 });
  const reference = nowLocal < windowStart ? windowStart : nowLocal;
  return ticks.find((t) => t >= reference) || null; // null = nothing left today
}

function isSameLocalDay(isoA, nowLocal) {
  if (!isoA) return false;
  const a = DateTime.fromISO(isoA, { setZone: true });
  return a.hasSame(nowLocal, 'day');
}

// pulls "PACING FROM h:mm AM/PM" off the page and returns {hour, minute} in 24h
async function getPagePacingTime(page) {
  const text = await page.locator('text=/PACING FROM/i').first().textContent();
  const match = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;

  let [, hh, mm, ampm] = match;
  hh = parseInt(hh, 10);
  mm = parseInt(mm, 10);
  if (ampm.toUpperCase() === 'PM' && hh !== 12) hh += 12;
  if (ampm.toUpperCase() === 'AM' && hh === 12) hh = 0;
  return { hour: hh, minute: mm };
}

async function sendToDiscord(payload) {
  const url = `${process.env.DISCORD_WEBHOOK_URL}?wait=true`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify(payload) })
  });

  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data || !data.id) throw new Error('Discord response missing message id — send not confirmed');
}

async function scrapeAndSend(page, slug, label, unit, timezone, region) {
  await page.goto(`https://wethr.net/market/${slug}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Model Details', { timeout: 15000 });

  const header = page.locator('th[onclick*="sortModelTable"]').filter({ hasText: '7D HI' }).first();
  const onclickCode = await header.getAttribute('onclick');
  await page.evaluate((code) => { eval(code); }, onclickCode);
  await page.waitForTimeout(300);
  await page.evaluate((code) => { eval(code); }, onclickCode);
  await page.waitForTimeout(500);

  const pacingRaw = await page.locator('text=/PACING FROM/i').first().textContent();
  const pacingMatch = pacingRaw.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  const pacingTimeText = pacingMatch ? pacingMatch[1].toUpperCase() : null;

  const table = page.locator('div, section')
    .filter({ hasText: 'Model Details' })
    .filter({ has: page.locator('table') })
    .last()
    .locator('table');

  const rows = await table.locator('tbody tr').all();
  const models = [];
  for (const row of rows) {
    const cells = await row.locator('td').allTextContents();
    if (cells.length < 10) continue;

    const modelName = cells[0].trim().replace(/\s*\(.*?\)\s*$/, '').trim();
    const rank = parseInt(cells[1].trim().replace('#', ''), 10);
    if (Number.isNaN(rank)) continue;

    const high = parseFloat(cells[2].trim().replace('°', ''));
    const pace = cells[9].trim();

    models.push({ model: modelName, rank, high, pace });
  }

  await sendToDiscord({ city: label, unit, region, timezone, pacing_time: pacingTimeText, models });
}

async function run() {
  const state = loadState();
  const nowByCity = ASIA_CITIES.map((city) => ({
    city,
    now: DateTime.now().setZone(city.tz)
  }));

  // figure out which cities are even in-window right now, cheaply, before touching a browser
  const dueCities = [];
  for (const { city, now } of nowByCity) {
    if (now.hour < START_HOUR || now.hour >= END_HOUR) continue; // outside 8am-6pm local

    let entry = state[city.slug];

    // no state yet, or stale from a previous day -> (re)compute today's initial target
    if (!entry || !isSameLocalDay(entry.dayStart, now)) {
      const target = computeNextTarget(now, city.cadenceMinutes, city.tickOffsetMinutes);
      entry = { dayStart: now.startOf('day').toISO(), nextTarget: target ? target.toISO() : null };
      state[city.slug] = entry;
    }

    if (!entry.nextTarget) continue; // nothing left to check today for this city
    const target = DateTime.fromISO(entry.nextTarget).setZone(city.tz);
    if (now >= target) dueCities.push({ city, now, target });
  }

  saveState(state); // persist any freshly-initialized targets even if nothing else happens this poll

  if (dueCities.length === 0) {
    console.log('Nothing due this poll.');
    return;
  }

  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
  const page = await context.newPage();

  await page.goto('https://wethr.net/login');
  await page.fill('input[type="email"]', process.env.WETHR_EMAIL);
  await page.fill('input[type="password"]', process.env.WETHR_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');

  for (const { city, target } of dueCities) {
    try {
      await page.goto(`https://wethr.net/market/${city.slug}`, { waitUntil: 'networkidle' });
      const pacing = await getPagePacingTime(page);

      const pacingDateTime = pacing
        ? target.set({ hour: pacing.hour, minute: pacing.minute, second: 0, millisecond: 0 })
        : null;

      if (!pacingDateTime || pacingDateTime < target) {
        console.log(`⏳ ${city.slug}: pacing not yet at ${target.toFormat('h:mm a')} (site shows ${pacing ? pacingDateTime.toFormat('h:mm a') : 'unreadable'}), will recheck next poll`);
        continue;
      }

      console.log(`→ ${city.slug}: pacing reached/passed ${target.toFormat('h:mm a')} (site shows ${pacingDateTime.toFormat('h:mm a')}), capturing now`);
      await scrapeAndSend(page, city.slug, city.label, UNIT, city.tz, 'asia');

      // advance to the next fixed-cadence target (from the target, not actual confirm time)
      const nextTarget = target.plus({ minutes: city.cadenceMinutes });
      const withinWindow = nextTarget.hour < END_HOUR;
      state[city.slug].nextTarget = withinWindow ? nextTarget.toISO() : null;
      saveState(state);

      console.log(`✓ ${city.slug} captured at pacing ${target.toFormat('h:mm a')}, next target ${withinWindow ? nextTarget.toFormat('h:mm a') : 'none (past window)'}`);
    } catch (err) {
      console.error(`✗ ${city.slug} failed:`, err.message);
    }
  }

  await browser.close();
}

run()
  .catch((err) => console.error('Fatal error:', err))
  .finally(() => {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  });