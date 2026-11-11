/**
 * Verification harness for the weather-dashboard Next.js app.
 *
 * From the repo root:
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs up
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs doctor
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs down
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs get /api/regions
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser open /
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser click --role link --name america
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser fill --role textbox --name "Search cities" --value tokyo
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text Regions [--exact]
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser count --role checkbox --name tokyo [--eq 1]
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser url
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser snapshot --aria --path evidence/browse-regions/home.aria.txt
 *   node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser screenshot --path evidence/browse-regions/home.png
 *
 * `up` stays in the foreground until `down`. One checkout can run one instance.
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(SKILL_ROOT, "..", "..", "..");
const DASHBOARD_DIR = path.join(REPO_ROOT, "weather-dashboard", "weather-dashboard");
const RUN_DIR = path.join(SKILL_ROOT, "run");
const EVIDENCE_DIR = path.join(SKILL_ROOT, "evidence");
const STATE_PATH = path.join(RUN_DIR, "state.json");
const NEXT_LOG = path.join(RUN_DIR, "next.log");

const ROSTER = [
  {
    city: "seattle",
    region: "america",
    timezone: "America/Los_Angeles",
    unit: "F",
    bracket: "62-63°F",
    weighted_avg: 62.4,
  },
  {
    city: "london",
    region: "europe",
    timezone: "Europe/London",
    unit: "C",
    bracket: "18°C",
    weighted_avg: 18.2,
  },
  {
    city: "tokyo",
    region: "asia",
    timezone: "Asia/Tokyo",
    unit: "C",
    bracket: "22°C",
    weighted_avg: 22.1,
  },
];

const HELP = `Verification harness for weather-dashboard. Run from the repo root.

  node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs <command>

Commands:
  up
  doctor
  down
  get <path>
  browser open <path>
  browser click --role <role> --name <name>
  browser fill --role <role> --name <name> --value <value>
  browser wait --text <text> [--exact]
  browser count --role <role> --name <name> [--eq <n>]
  browser url
  browser snapshot --aria --path <evidence-path>
  browser screenshot --path <evidence-path>

Environment:
  VERIFY_PORT   Next.js port (default 4173). A second up in this checkout is refused
                even if VERIFY_PORT differs, because both servers would share .next.
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(token);
  }
  return { positional, flags };
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function writeState(partial) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const prev = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : {};
  const next = { ...prev, ...partial };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tail(file, max = 40) {
  if (!fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  return lines.slice(-max).join("\n");
}

async function killPid(pid) {
  if (!pid || !alive(pid)) return;
  await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function listNodeProcesses() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", ps], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isDashboardNext(commandLine) {
  if (!commandLine) return false;
  const normalized = commandLine.toLowerCase();
  const isNext = normalized.includes(`${path.sep}next${path.sep}dist${path.sep}bin${path.sep}next`) || normalized.includes(" next dev") || normalized.includes("/next dev");
  return isNext && normalized.includes("weather-dashboard");
}

async function parentPid(pid) {
  const safe = Number(pid);
  if (!Number.isInteger(safe) || safe <= 0) return 0;
  const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${safe}").ParentProcessId`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true });
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function listeningPids(port) {
  const { stdout } = await execFileAsync("netstat", ["-ano"], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  const pids = new Set();
  const portRe = new RegExp(`[:\\]]${port}(?:\\s|$)`);
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    if (!portRe.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/).at(-1));
    if (pid) pids.add(pid);
  }
  return [...pids];
}

async function ownsListener(listenerPid, state) {
  let current = listenerPid;
  for (let i = 0; i < 8 && current; i++) {
    if (current === state.nextPid || current === state.supervisorPid) return true;
    current = await parentPid(current);
  }
  return false;
}

function localDate(timeZone, now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

function localHour(timeZone, now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  return Number(parts.find((part) => part.type === "hour")?.value ?? "0");
}

function liveCities(now = new Date()) {
  return ROSTER.filter((city) => {
    const hour = localHour(city.timezone, now);
    return hour >= 8 && hour < 18;
  }).map((city) => city.city);
}

function historicalDate(now) {
  const utcToday = now.toISOString().slice(0, 10);
  const localDates = new Set(ROSTER.map((city) => localDate(city.timezone, now)));
  for (const candidate of ["2026-10-15", "2026-09-15", "2026-08-15"]) {
    if (candidate !== utcToday && !localDates.has(candidate)) return candidate;
  }
  throw new Error("could not choose a historical seed date");
}

function tickDocs(spec, date) {
  return ["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM"].map((pacingTime, index) => ({
    city: spec.city,
    region: spec.region,
    timezone: spec.timezone,
    local_date: date,
    captured_at: new Date(`${date}T${String(9 + index).padStart(2, "0")}:00:00.000Z`),
    pacing_time: pacingTime,
    weighted_avg: spec.weighted_avg,
    unit: spec.unit,
    bracket: spec.bracket,
    yes_price: 0.42,
    winning_bracket: null,
    winning_bracket_low: null,
    winning_bracket_high: null,
  }));
}

function statsDocs(date) {
  const hours = Array.from({ length: 10 }, () => 1);
  return Array.from({ length: 10 }, (_, index) => {
    const low = 50 + index * 2;
    return {
      city: "seattle",
      local_date: date,
      bracket: `${low}-${low + 1}°F`,
      method: "combined",
      first_tick_price_cents: 40,
      first_tick_hour: 1,
      has_price: true,
      tick_count_through_hour: hours,
      rank_through_hour: hours,
      is_leader_through_hour: hours.map(() => true),
      price_at_hour: hours.map(() => 40),
      lead_margin_through_hour: hours.map(() => 0.5),
      final_tick_count: 4,
      final_rank: 1,
      resolved: true,
      won: true,
      edge_cents: 15,
      computed_at: new Date(`${date}T18:00:00.000Z`),
    };
  });
}

async function seedDatabase(uri, now) {
  const { MongoClient } = await import("mongodb");
  const utcToday = now.toISOString().slice(0, 10);
  const past = historicalDate(now);
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db("weather");
    const ticks = [];
    const cache = [];
    const datesByCity = {};
    for (const spec of ROSTER) {
      const dates = [...new Set([utcToday, localDate(spec.timezone, now), ...(spec.city === "seattle" ? [past] : [])])];
      datesByCity[spec.city] = dates;
      for (const date of dates) {
        ticks.push(...tickDocs(spec, date));
        cache.push({ city: spec.city, date, tzOffsetMs: 0, brackets: [], cachedAt: now });
      }
    }
    await db.collection("high-temp").insertMany(ticks);
    await db.collection("price-history-cache").insertMany(cache);
    await db.collection("stats_features").insertMany(statsDocs(past));
    const live = liveCities(now);
    if (live.length === 0) {
      const hours = Object.fromEntries(ROSTER.map((city) => [city.city, localHour(city.timezone, now)]));
      throw new Error(`seed produced no live city: ${JSON.stringify(hours)}`);
    }
    return {
      utcToday,
      historicalDate: past,
      liveCities: live,
      datesByCity,
      cities: ROSTER.map((city) => city.city),
    };
  } finally {
    await client.close();
  }
}

function verificationEnv(mongoUri, url) {
  return {
    ...process.env,
    MONGO_URI: mongoUri,
    NEXT_PUBLIC_BASE_URL: url,
    AUTOMATION_ENABLED: "false",
    AUTOMATION_DEV_BYPASS: "",
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    POLYBOT_BUY_URL: "",
    POLYBOT_INTENT_SECRET: "",
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
    AUTOMATION_ADMIN_EMAILS: "",
    AUTOMATION_CRON_SECRET: "",
    AUTOMATION_ALLOWED_ORIGINS: "",
  };
}

async function ensureChromium() {
  const { chromium } = await import("playwright");
  if (fs.existsSync(chromium.executablePath())) return;
  console.log("Installing Chromium for verification...");
  await new Promise((resolve, reject) => {
    const cli = path.join(SKILL_ROOT, "node_modules", "playwright", "cli.js");
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      cwd: SKILL_ROOT,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`playwright install chromium exited ${code}`))));
  });
}

async function waitForRegions(url, nextChild) {
  const deadline = Date.now() + 120_000;
  let last = "no response yet";
  while (Date.now() < deadline) {
    if (nextChild.exitCode !== null) {
      throw new Error(`next dev exited ${nextChild.exitCode}\n${tail(NEXT_LOG)}`);
    }
    try {
      const response = await fetch(`${url}/api/regions`, { signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      const america = body.regions?.find((region) => region.region === "america");
      if (response.ok && america?.cityCount >= 1) return;
      last = `HTTP ${response.status} ${JSON.stringify(body).slice(0, 240)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`dashboard did not become usable: ${last}\n${tail(NEXT_LOG)}`);
}

async function assertHomeRenders(url) {
  const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(20_000) });
  const html = await response.text();
  if (!response.ok || !html.includes("Regions") || !html.includes("america")) {
    throw new Error(`home page is not usable (HTTP ${response.status})`);
  }
}

function sameOrigin(base, targetPath) {
  const url = new URL(targetPath, base);
  if (url.origin !== new URL(base).origin) {
    throw new Error(`refusing ${url.href}; verification origin is ${new URL(base).origin}`);
  }
  return url;
}

function evidenceFile(relativePath) {
  if (!relativePath || relativePath === true) throw new Error("pass --path under evidence/");
  const absolute = path.resolve(SKILL_ROOT, relativePath);
  const root = path.resolve(EVIDENCE_DIR);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`path must stay under ${root}`);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return absolute;
}

async function browserCommand(page, payload) {
  if (payload.cmd === "open") {
    const url = sameOrigin(payload.baseUrl, payload.path);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { url: page.url() };
  }
  if (payload.cmd === "url") return { url: page.url() };
  if (payload.cmd === "click" || payload.cmd === "fill" || payload.cmd === "count") {
    if (!payload.role || !payload.name) throw new Error("--role and --name are required");
    const locator = page.getByRole(payload.role, { name: payload.name, exact: Boolean(payload.exact) });
    const count = await locator.count();
    if (payload.cmd === "count") {
      if (payload.eq !== undefined && count !== Number(payload.eq)) {
        throw new Error(`expected ${payload.eq} ${payload.role} named ${JSON.stringify(payload.name)}, found ${count}`);
      }
      return { count };
    }
    if (count !== 1) {
      throw new Error(`expected 1 ${payload.role} named ${JSON.stringify(payload.name)}, found ${count}`);
    }
    if (payload.cmd === "click") {
      await locator.click({ timeout: 15_000 });
      return { url: page.url() };
    }
    if (payload.value === undefined) throw new Error("--value is required");
    await locator.fill(String(payload.value), { timeout: 15_000 });
    return { url: page.url() };
  }
  if (payload.cmd === "wait") {
    if (!payload.text) throw new Error("--text is required");
    await page.getByText(payload.text, { exact: Boolean(payload.exact) }).first().waitFor({
      state: "visible",
      timeout: 20_000,
    });
    return { url: page.url() };
  }
  if (payload.cmd === "snapshot") {
    const file = evidenceFile(payload.path);
    const yaml = await page.locator("body").ariaSnapshot();
    fs.writeFileSync(file, `url: ${page.url()}\n${yaml}`);
    return { path: file, url: page.url() };
  }
  if (payload.cmd === "screenshot") {
    const file = evidenceFile(payload.path);
    await page.screenshot({ path: file, fullPage: true });
    return { path: file, url: page.url() };
  }
  throw new Error(`unknown browser command ${payload.cmd}`);
}

async function postJson(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { ok: false, error: text };
  }
  if (!response.ok || parsed?.ok === false) {
    throw new Error(parsed?.error || `control request failed (${response.status})`);
  }
  return parsed;
}

async function cmdUp() {
  const existing = readState();
  if (existing && alive(existing.supervisorPid)) {
    console.error(`A verification instance is already running at ${existing.url || "(still starting)"}. Run down before up.`);
    process.exit(1);
  }
  if (existing) {
    console.error("Stale verification state is still on disk. Run down, then up.");
    process.exit(1);
  }

  const port = Number(process.env.VERIFY_PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("VERIFY_PORT must be an integer port");
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}`;

  const nodeProcs = await listNodeProcesses();
  const foreignNext = nodeProcs.filter((proc) => isDashboardNext(proc.CommandLine));
  if (foreignNext.length > 0) {
    console.error("Refusing to start: another Next.js process is already using weather-dashboard (they would share .next). Stop that dev server, then run up.");
    for (const proc of foreignNext) console.error(`  pid ${proc.ProcessId}: ${proc.CommandLine}`);
    process.exit(1);
  }
  if (!(await portFree(port))) {
    console.error(`Port ${port} is already in use. Stop whatever owns it, or set VERIFY_PORT only after down has cleared the previous verification instance.`);
    process.exit(1);
  }

  const nextBin = path.join(DASHBOARD_DIR, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextBin)) {
    console.error(`Missing ${nextBin}. Run npm install in weather-dashboard/weather-dashboard, then up.`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(SKILL_ROOT, "node_modules", "mongodb-memory-server"))) {
    console.error("Missing harness dependencies. Run: npm install --prefix .cursor/skills/verify-weather-dashboard");
    process.exit(1);
  }

  fs.mkdirSync(RUN_DIR, { recursive: true });
  try {
    const fd = fs.openSync(STATE_PATH, "wx");
    fs.writeFileSync(fd, JSON.stringify({ status: "starting", supervisorPid: process.pid, port, url }, null, 2));
    fs.closeSync(fd);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      console.error("Verification state already exists. Run down, then up.");
      process.exit(1);
    }
    throw error;
  }

  let replSet = null;
  let nextChild = null;
  let browserServer = null;
  let browser = null;
  let page = null;
  let control = null;
  let release = () => {};
  const stopped = new Promise((resolve) => {
    release = resolve;
  });
  let stopping = false;

  const cleanup = async (code) => {
    if (stopping) return;
    stopping = true;
    try { if (page) await page.context().close(); } catch { /* already closed */ }
    try { if (browser) await browser.close(); } catch { /* already closed */ }
    try { if (browserServer) await browserServer.close(); } catch { /* already closed */ }
    try { if (control) await new Promise((resolve) => control.close(resolve)); } catch { /* already closed */ }
    if (nextChild?.pid) await killPid(nextChild.pid);
    try { if (replSet) await replSet.stop(); } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
    process.exit(code);
  };

  process.on("SIGINT", () => { void cleanup(0); });
  process.on("SIGTERM", () => { void cleanup(0); });

  try {
    console.log("Starting a disposable MongoDB replica set...");
    const { MongoMemoryReplSet } = await import("mongodb-memory-server");
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
      instanceOpts: [{ launchTimeout: 60_000 }],
    });
    const mongoUri = replSet.getUri();
    const mongodPids = replSet.servers
      .map((server) => server.instanceInfo?.instance?.mongodProcess?.pid)
      .filter(Boolean);
    writeState({ mongoUri, mongodPids, dbPath: replSet.servers[0]?.instanceInfo?.dbPath ?? null });

    const now = new Date();
    console.log("Seeding weather.high-temp, price-history-cache, and stats_features...");
    const seed = await seedDatabase(mongoUri, now);
    writeState({ seed });

    await ensureChromium();

    const dashboardPackage = JSON.parse(fs.readFileSync(path.join(DASHBOARD_DIR, "package.json"), "utf8"));
    const nextPackage = JSON.parse(fs.readFileSync(path.join(DASHBOARD_DIR, "node_modules", "next", "package.json"), "utf8"));
    const log = fs.createWriteStream(NEXT_LOG, { flags: "w" });
    nextChild = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: DASHBOARD_DIR,
      env: verificationEnv(mongoUri, url),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    nextChild.stdout.pipe(log);
    nextChild.stderr.pipe(log);
    writeState({
      nextPid: nextChild.pid,
      dashboardVersion: dashboardPackage.version,
      nextVersion: nextPackage.version,
    });
    console.log(`Waiting until ${url} serves seeded regions...`);
    await waitForRegions(url, nextChild);
    await assertHomeRenders(url);

    const { chromium } = await import("playwright");
    browserServer = await chromium.launchServer({
      headless: true,
      executablePath: chromium.executablePath(),
    });
    browser = await chromium.connect(browserServer.wsEndpoint());
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on("dialog", (dialog) => { void dialog.dismiss(); });

    control = http.createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/shutdown") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        release();
        return;
      }
      if (request.method === "POST" && request.url === "/browser") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          const result = await browserCommand(page, { ...payload, baseUrl: url });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const controlPort = await new Promise((resolve, reject) => {
      control.once("error", reject);
      control.listen(0, "127.0.0.1", () => resolve(control.address().port));
    });
    writeState({ status: "ready", controlPort, browserPid: browserServer.process?.()?.pid ?? null });
    console.log(`READY url=${url}`);
    await stopped;
    await cleanup(0);
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : error);
    await cleanup(1);
  }
}

async function cmdDoctor() {
  const state = readState();
  const problems = [];
  if (!state || state.status !== "ready") {
    problems.push(state ? "verification instance is still starting" : "no verification instance; run up");
  } else if (!alive(state.supervisorPid)) {
    problems.push("supervisor pid is not running; run down, then up");
  }

  let regions = null;
  let live = null;
  let portOwners = [];
  if (problems.length === 0) {
    try {
      const response = await fetch(`${state.url}/api/regions`, { signal: AbortSignal.timeout(10_000) });
      regions = await response.json();
      if (!response.ok) problems.push(`/api/regions returned HTTP ${response.status}`);
    } catch (error) {
      problems.push(`/api/regions failed: ${error instanceof Error ? error.message : error}`);
    }
    try {
      const response = await fetch(`${state.url}/api/live`, { signal: AbortSignal.timeout(10_000) });
      live = await response.json();
      if (!response.ok) problems.push(`/api/live returned HTTP ${response.status}`);
    } catch (error) {
      problems.push(`/api/live failed: ${error instanceof Error ? error.message : error}`);
    }
    try {
      const home = await fetch(`${state.url}/`, { signal: AbortSignal.timeout(20_000) });
      const html = await home.text();
      if (!home.ok || !html.includes("Weather Dashboard") || !html.includes("Regions")) {
        problems.push(`home page HTTP ${home.status} did not render Weather Dashboard`);
      }
    } catch (error) {
      problems.push(`home page failed: ${error instanceof Error ? error.message : error}`);
    }

    const expected = { america: 1, asia: 1, europe: 1 };
    for (const [region, count] of Object.entries(expected)) {
      const got = regions?.regions?.find((row) => row.region === region)?.cityCount;
      if (got !== count) problems.push(`${region} cityCount is ${got}, expected ${count}`);
    }
    const apiLive = (live?.cities ?? []).filter((city) => city.isLive).map((city) => city.city).sort();
    const fresh = liveCities().sort();
    if (apiLive.join() !== fresh.join()) {
      problems.push(`live cities ${JSON.stringify(apiLive)} differ from the clock check ${JSON.stringify(fresh)}`);
    }
    const seen = (live?.cities ?? []).map((city) => city.city).sort();
    if (seen.join() !== [...state.seed.cities].sort().join()) {
      problems.push(`mongo cities ${JSON.stringify(seen)} are not the seeded roster`);
    }

    portOwners = await listeningPids(state.port);
    if (portOwners.length === 0) problems.push(`nothing is listening on ${state.port}`);
    for (const pid of portOwners) {
      if (!(await ownsListener(pid, state))) problems.push(`port ${state.port} is owned by pid ${pid}, not this verification run`);
    }

    const dashboardPackage = JSON.parse(fs.readFileSync(path.join(DASHBOARD_DIR, "package.json"), "utf8"));
    const nextPackage = JSON.parse(fs.readFileSync(path.join(DASHBOARD_DIR, "node_modules", "next", "package.json"), "utf8"));
    if (dashboardPackage.version !== state.dashboardVersion) problems.push("dashboard package version changed since up");
    if (nextPackage.version !== state.nextVersion) problems.push("next version changed since up");

    const procs = await listNodeProcesses();
    for (const proc of procs) {
      if (!isDashboardNext(proc.CommandLine)) continue;
      if (proc.ProcessId === state.nextPid) continue;
      if (await ownsListener(proc.ProcessId, state)) continue;
      problems.push(`foreign next process pid ${proc.ProcessId} shares this checkout`);
    }
  }

  const report = {
    ok: problems.length === 0,
    url: state?.url ?? null,
    port: state?.port ?? null,
    portOwnerPids: portOwners,
    nextPid: state?.nextPid ?? null,
    supervisorPid: state?.supervisorPid ?? null,
    dashboardVersion: state?.dashboardVersion ?? null,
    nextVersion: state?.nextVersion ?? null,
    dbPath: state?.dbPath ?? null,
    mongoIsolated: Boolean(state?.mongoUri?.includes("127.0.0.1")),
    utcToday: state?.seed?.utcToday ?? null,
    historicalDate: state?.seed?.historicalDate ?? null,
    seededCities: state?.seed?.cities ?? [],
    datesByCity: state?.seed?.datesByCity ?? null,
    liveCities: problems.length === 0 ? (live?.cities ?? []).filter((city) => city.isLive) : [],
    regions: regions?.regions ?? null,
    problems,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

async function cmdDown() {
  const state = readState();
  if (!state) {
    console.log("No verification instance is recorded.");
    return;
  }
  if (state.controlPort && alive(state.supervisorPid)) {
    try {
      await postJson(state.controlPort, "/shutdown");
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && alive(state.supervisorPid)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (alive(state.supervisorPid)) await killPid(state.supervisorPid);
  if (alive(state.nextPid)) await killPid(state.nextPid);
  for (const pid of state.mongodPids ?? []) {
    if (alive(pid)) await killPid(pid);
  }
  if (alive(state.browserPid)) await killPid(state.browserPid);
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  console.log(`Stopped. Evidence remains in ${EVIDENCE_DIR}`);
}

async function cmdGet(targetPath) {
  const state = readState();
  if (!state || state.status !== "ready") {
    console.error("No ready verification instance. Run up, then doctor.");
    process.exit(1);
  }
  const url = sameOrigin(state.url, targetPath);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  console.log(`HTTP ${response.status}`);
  console.log(text);
  if (!response.ok) process.exit(1);
}

async function cmdBrowser(positional, flags) {
  const state = readState();
  if (!state || state.status !== "ready" || !state.controlPort) {
    console.error("No ready verification instance. Run up, then doctor.");
    process.exit(1);
  }
  const sub = positional[0];
  const payload = { cmd: sub, exact: Boolean(flags.exact) };
  if (sub === "open") payload.path = positional[1];
  if (sub === "click" || sub === "fill" || sub === "count") {
    payload.role = flags.role;
    payload.name = flags.name;
  }
  if (sub === "fill") payload.value = flags.value;
  if (sub === "count" && flags.eq !== undefined) payload.eq = Number(flags.eq);
  if (sub === "wait") payload.text = flags.text;
  if (sub === "snapshot" || sub === "screenshot") {
    if (!flags.aria && sub === "snapshot") throw new Error("snapshot requires --aria");
    payload.path = flags.path;
  }
  const result = await postJson(state.controlPort, "/browser", payload);
  if (sub === "url") console.log(result.result.url);
  else if (sub === "count") console.log(String(result.result.count));
  else if (sub === "snapshot" || sub === "screenshot") console.log(result.result.path);
  else if (result.result?.url) console.log(result.result.url);
}

const parsed = parseArgs(process.argv.slice(2));
const command = parsed.positional[0];
const rest = parsed.positional.slice(1);

if (!command || command === "help" || parsed.flags.help) {
  console.log(HELP);
  process.exit(command ? 0 : 1);
}

const commands = {
  up: () => cmdUp(),
  doctor: () => cmdDoctor(),
  down: () => cmdDown(),
  get: () => cmdGet(rest[0]),
  browser: () => cmdBrowser(rest, parsed.flags),
};

if (!commands[command]) {
  console.error(`Unknown command ${command}`);
  console.log(HELP);
  process.exit(1);
}

if ((command === "get" || command === "browser") && rest.length === 0) {
  console.error(`Missing argument for ${command}`);
  process.exit(1);
}

try {
  await commands[command]();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
