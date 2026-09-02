// test-scrape.js
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

const TEST_SLUG = 'seoul'; // change this to test other cities

async function getPagePacingTime(page) {
  const text = await page.locator('text=/PACING FROM/i').first().textContent();
  const match = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  return match ? `${match[1]}:${match[2]} ${match[3].toUpperCase()}` : null;
}

async function scrapeModelDetails(page, slug) {
  await page.goto(`https://wethr.net/market/${slug}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Model Details', { timeout: 15000 });

  // sort by 7D HI ascending, same trick as the screenshot scripts
  const header = page.locator('th[onclick*="sortModelTable"]').filter({ hasText: '7D HI' }).first();
  const onclickCode = await header.getAttribute('onclick');
  await page.evaluate((code) => { eval(code); }, onclickCode);
  await page.waitForTimeout(300);
  await page.evaluate((code) => { eval(code); }, onclickCode);
  await page.waitForTimeout(500);

  const pacingTime = await getPagePacingTime(page);

  const table = page.locator('div, section')
    .filter({ hasText: 'Model Details' })
    .filter({ has: page.locator('table') })
    .last()
    .locator('table');

  const rows = await table.locator('tbody tr').all();

  const models = [];
  for (const row of rows) {
    const cells = await row.locator('td').allTextContents();
    if (cells.length < 10) continue; // skip malformed/header rows

    const modelNameRaw = cells[0].trim();
    const modelName = modelNameRaw.replace(/\s*\(.*?\)\s*$/, '').trim(); // strip "(18Z)" etc.

    const rankRaw = cells[1].trim();
    const rank = parseInt(rankRaw.replace('#', ''), 10);
    if (Number.isNaN(rank)) continue; // skip rows with no rank (—)

    const highRaw = cells[2].trim();
    const high = parseFloat(highRaw.replace('°', ''));

    const pace = cells[9].trim();

    models.push({ model: modelName, rank, high, pace });
  }

  return {
    unit: 'F',
    pacing_time: pacingTime,
    models
  };
}

async function run() {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
  const page = await context.newPage();

  await page.goto('https://wethr.net/login');
  await page.fill('input[type="email"]', process.env.WETHR_EMAIL);
  await page.fill('input[type="password"]', process.env.WETHR_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');

  const result = await scrapeModelDetails(page, TEST_SLUG);

  console.log(JSON.stringify(result, null, 2));
  fs.writeFileSync('test-scrape-output.json', JSON.stringify(result, null, 2));

  await browser.close();
}

run().catch(console.error);