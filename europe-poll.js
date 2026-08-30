// europe-poll.js
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { DateTime } = require('luxon');

const EUROPE_CITIES = [
  { slug: 'london',    label: 'london',    tz: 'Europe/London',    cadenceMinutes: 30, tickOffsetMinutes: 20 },
  { slug: 'munich',    label: 'munich',    tz: 'Europe/Berlin',    cadenceMinutes: 30, tickOffsetMinutes: 20 },
  { slug: 'milan',     label: 'milan',     tz: 'Europe/Rome',      cadenceMinutes: 30, tickOffsetMinutes: 20 },
  { slug: 'amsterdam', label: 'amsterdam', tz: 'Europe/Amsterdam', cadenceMinutes: 30, tickOffsetMinutes: 25 },
  { slug: 'madrid',    label: 'madrid',    tz: 'Europe/Madrid',    cadenceMinutes: 30, tickOffsetMinutes: 0 },
  { slug: 'parislb',   label: 'paris',     tz: 'Europe/Paris',     cadenceMinutes: 30, tickOffsetMinutes: 0 }
];

const START_HOUR = 8;
const END_HOUR = 18;

const STATE_PATH = path.join(__dirname, 'state-europe.json');
const OUT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

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

async function sendToDiscord(label, filePath) {
  const form = new FormData();
  form.append('content', label);
  form.append('file', fs.createReadStream(filePath), path.basename(filePath));

  const url = `${process.env.DISCORD_WEBHOOK_URL}?wait=true`;
  const res = await fetch(url, { method: 'POST', body: form });

  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data || !data.id) throw new Error('Discord response missing message id — send not confirmed');
}

async function captureAndSend(page, slug, label) {
  await page.goto(`https://wethr.net/market/${slug}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Model Details', { timeout: 15000 });

  const header = page.locator('th[onclick*="sortModelTable"]').filter({ hasText: '7D HI' }).first();
  const onclickCode = await header.getAttribute('onclick');
  await page.evaluate((code) => { eval(code); }, onclickCode);
  await page.waitForTimeout(300);
  await page.evaluate((code) => { eval(code); }, onclickCode);
  await page.waitForTimeout(500);

  const table = page.locator('div, section')
    .filter({ hasText: 'Model Details' })
    .filter({ has: page.locator('table') })
    .last();

  await table.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);

  const box = await table.boundingBox();
  if (!box) throw new Error('table bounding box not found');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(OUT_DIR, `${slug}-${timestamp}.png`);
  await page.screenshot({ path: filePath, clip: box });

  await sendToDiscord(label, filePath);
  fs.unlinkSync(filePath);
}

async function run() {
  const state = loadState();
  const nowByCity = EUROPE_CITIES.map((city) => ({
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
      await captureAndSend(page, city.slug, city.label);

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

run().catch(console.error);