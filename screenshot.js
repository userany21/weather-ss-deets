// screenshot.js
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const CITIES = {
  america: [
    { slug: 'sanfrancisco', label: 'san francisco', coast: 'west' },
    { slug: 'seattle',      label: 'seattle',        coast: 'west' },
    { slug: 'losangeles',   label: 'los angeles',    coast: 'west' },
    { slug: 'laguardia',    label: 'nyc',            coast: 'east' },
    { slug: 'atlanta',      label: 'atlanta',        coast: 'east' },
    { slug: 'miami',        label: 'miami',          coast: 'east' }
  ],
  asia: [
    { slug: 'hongkongobs', label: 'hong kong' },
    { slug: 'beijing',     label: 'beijing' },
    { slug: 'shanghai',    label: 'shanghai' },
    { slug: 'shenzhen',    label: 'shenzhen' },
    { slug: 'tokyo',       label: 'tokyo' },
    { slug: 'seoul',       label: 'seoul' },
    { slug: 'singapore',   label: 'singapore' }
  ],
  europe: [
    { slug: 'amsterdam', label: 'amsterdam' },
    { slug: 'london',    label: 'london' },
    { slug: 'madrid',    label: 'madrid' },
    { slug: 'milan',     label: 'milan' },
    { slug: 'munich',    label: 'munich' },
    { slug: 'parislb',   label: 'paris' }
  ]
};

const OUT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// returns true only if Discord confirms the message actually posted (has a real id)
async function sendToDiscord(label, filePath) {
  const form = new FormData();
  form.append('content', label);
  form.append('file', fs.createReadStream(filePath), path.basename(filePath));

  const url = `${process.env.DISCORD_WEBHOOK_URL}?wait=true`;
  const res = await fetch(url, { method: 'POST', body: form });

  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  if (!data || !data.id) {
    throw new Error('Discord response missing message id — send not confirmed');
  }
  return true;
}

// does the full navigate -> sort -> screenshot -> send flow for one city, once
async function captureAndSendCity(page, slug, label, timestamp) {
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

  const filePath = path.join(OUT_DIR, `${slug}-${timestamp}.png`);
  await page.screenshot({ path: filePath, clip: box });

  // only delete if discord actually confirms the post
  await sendToDiscord(label, filePath);
  fs.unlinkSync(filePath);

  return true;
}

async function run(cityList) {
  const browser = await chromium.launch({
    args: ['--disable-gpu', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1400 }
  });
  const page = await context.newPage();

  await page.goto('https://wethr.net/login');
  await page.fill('input[type="email"]', process.env.WETHR_EMAIL);
  await page.fill('input[type="password"]', process.env.WETHR_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const city of cityList) {
    const { slug, label } = city;
    let success = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !success; attempt++) {
      try {
        await captureAndSendCity(page, slug, label, timestamp);
        console.log(`✓ ${slug} captured, sent as "${label}", confirmed, and cleaned up (attempt ${attempt})`);
        success = true;
      } catch (err) {
        console.error(`✗ ${slug} attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    if (!success) {
      console.error(`✗✗ ${slug} FAILED after ${MAX_ATTEMPTS} attempts — screenshot left on disk if it exists`);
    }
  }

  await browser.close();
}

const region = process.argv[2];

if (!region || !CITIES[region]) {
  console.error(`Usage: node screenshot.js <america|asia|europe>`);
  process.exit(1);
}

run(CITIES[region]).catch(console.error);