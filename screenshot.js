// screenshot.js
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CITIES = [
  'sanfrancisco',
  'newyork',
  'chicago',
  'losangeles',
  'miami',
  'seattle'
  // confirm these slugs match wethr.net's actual URLs — you may need to
  // grab them from the Market Directory page
];

const OUT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

async function run() {
  const browser = await chromium.launch({
    args: ['--disable-gpu', '--disable-dev-shm-usage'] // memory-friendly flags
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  // --- log in once ---
  await page.goto('https://wethr.net/login'); // confirm this is the real login URL
  await page.fill('input[type="email"]', process.env.WETHR_EMAIL);
  await page.fill('input[type="password"]', process.env.WETHR_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const city of CITIES) {
    try {
      await page.goto(`https://wethr.net/market/${city}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('text=Model Details', { timeout: 15000 });

      // adjust this selector once we confirm the real DOM structure
      const table = page.locator('div, section')
  .filter({ hasText: 'Model Details' })
  .filter({ has: page.locator('table') })
  .last();
      await table.screenshot({ path: path.join(OUT_DIR, `${city}-${timestamp}.png`) });

      console.log(`✓ ${city} captured`);
    } catch (err) {
      console.error(`✗ ${city} failed:`, err.message);
    }
  }

  await browser.close();
}

run().catch(console.error);