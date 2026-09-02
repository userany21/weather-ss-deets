// america-poll.js
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { DateTime } = require('luxon');

const AMERICA_CITIES = [
  { slug: 'sanfrancisco', label: 'san francisco', tz: 'America/Los_Angeles', cadenceMinutes: 15, tickOffsetMinutes: 0, coast: 'west' },
  { slug: 'seattle',      label: 'seattle',        tz: 'America/Los_Angeles', cadenceMinutes: 15, tickOffsetMinutes: 0, coast: 'west' },
  { slug: 'losangeles',   label: 'los angeles',    tz: 'America/Los_Angeles', cadenceMinutes: 15, tickOffsetMinutes: 0, coast: 'west' },
  { slug: 'laguardia',    label: 'nyc',            tz: 'America/New_York',   cadenceMinutes: 15, tickOffsetMinutes: 0, coast: 'east' },
  { slug: 'atlanta',      label: 'atlanta',        tz: 'America/New_York',   cadenceMinutes: 15, tickOffsetMinutes: 0, coast: 'east' },
  { slug: 'miami',        label: 'miami',          tz: 'America/New_York',   cadenceMinutes: 15, tickOffsetMinutes: 0, coast: 'east' }
];

const UNIT = 'F';

const START_HOUR = 8;
const END_HOUR = 18;

const STATE_PATH = path.join(__dirname, 'state-america.json');
const OUT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const LOCK_PATH = path.join(__dirname, '.america-poll.lock');

if (fs.existsSync(LOCK_PATH)) {
  const lockAge = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
  const STALE_LOCK_MS = 10 * 60 * 1000; // 10 minutes

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

function computeNextTarget(nowLocal, cadenceMinutes, tickOffsetMinutes) {
  const dayStart = nowLocal.startOf('day');
  const ticks = getTicksForDay(dayStart, cadenceMinutes, tickOffsetMinutes);
  const windowStart = dayStart.set({ hour: START_HOUR, minute: 0 });
  const reference = nowLocal < windowStart ? windowStart : nowLocal;
  return ticks.find((t) => t >= reference) || null;
}

function isSameLocalDay(isoA, nowLocal) {
    if (!isoA) return false;
    const a = DateTime.fromISO(isoA, { setZone: true });
    return a.hasSame(nowLocal, 'day');
  }

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

async function scrapeAndSend(page, slug, label, unit) {
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

  await sendToDiscord({ city: label, unit, pacing_time: pacingTimeText, models });
}

async function run() {
  const state = loadState();
  const nowByCity = AMERICA_CITIES.map((city) => ({
    city,
    now: DateTime.now().setZone(city.tz)
  }));

  const dueCities = [];
  for (const { city, now } of nowByCity) {
    if (now.hour < START_HOUR || now.hour >= END_HOUR) continue;

    let entry = state[city.slug];

    if (!entry || !isSameLocalDay(entry.dayStart, now)) {
      const target = computeNextTarget(now, city.cadenceMinutes, city.tickOffsetMinutes);
      entry = { dayStart: now.startOf('day').toISO(), nextTarget: target ? target.toISO() : null };
      state[city.slug] = entry;
    }

    if (!entry.nextTarget) continue;
    const target = DateTime.fromISO(entry.nextTarget).setZone(city.tz);
    if (now >= target) dueCities.push({ city, now, target });
  }

  saveState(state);

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
      await scrapeAndSend(page, city.slug, city.label, UNIT);

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