---
name: verify-weather-dashboard
description: Drive the weather-dashboard Next.js UI (region drilldown, Live now, Stats Explorer, Auto-buy) in a disposable browser against a disposable Mongo replica set. Use when proving a dashboard change, checking a user-facing flow, or before calling a UI change done.
---

# Verify weather-dashboard

The primary surface is the Next.js app in `weather-dashboard/weather-dashboard`. A user opens it in a browser and moves from regions to a city day, Live now, Stats Explorer, and Auto-buy. The repo also has screenshot pollers (`america-poll.js`, `asia-poll.js`, `europe-poll.js`) and `npm test` at the repo root. This skill does not start those. The pollers write to the real `MONGO_URI`.

Run every command from the repo root. The harness is `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs`. One checkout can run one verification instance. A second `up` is refused while the first is alive, including when `VERIFY_PORT` differs, because both servers would share `weather-dashboard/weather-dashboard/.next`.

## Launch

Install harness dependencies once (this does not change the dashboard's dependencies):

```
npm install --prefix .cursor/skills/verify-weather-dashboard
```

Start the instance and leave the process running:

```
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs up
```

`up` refuses to start when another Next.js process is already using `weather-dashboard`, or when port 4173 is taken. Override the port with `VERIFY_PORT` only for a checkout that does not already have a verification instance.

What `up` does:

1. Starts a new single-node MongoDB replica set on `127.0.0.1` with an empty data directory. The first run downloads a MongoDB binary. Change streams need a replica set; a standalone `mongod` makes `/api/stream` fail.
2. Seeds database `weather` in that empty server. Collections are `high-temp`, `price-history-cache`, and `stats_features`. Seeded cities are `seattle`, `london`, and `tokyo`. Each city gets ticks on the UTC date and on that city's local date. Seattle also gets ticks on the historical date printed by `doctor`. Ten resolved `combined` stats rows for Seattle are stored on that historical date, brackets `50-51°F` through `68-69°F`. The price cache stores an empty bracket list so `/api/prices-history` does not call Polymarket during verification.
3. Starts `next dev -H 127.0.0.1 -p 4173` from `weather-dashboard/weather-dashboard` with `MONGO_URI` pointed at the disposable server and `NEXT_PUBLIC_BASE_URL` set to that same origin. `AUTOMATION_ENABLED` is `false`. Supabase, Polybot, and Cloudflare Access variables are set empty so a `.env.local` in the dashboard cannot attach this process to production. There is no migration step; the app reads collections directly.
4. Launches headless Chromium. The first run installs the Chromium binary through Playwright.

Ready is the line `READY url=http://127.0.0.1:4173` (the port changes if `VERIFY_PORT` is set). `up` prints that only after `GET /api/regions` reports America with at least one city and `GET /` renders the Regions page. A process that accepts a socket before that line is not ready.

The dashboard's own dev command remains `npm run dev` in `weather-dashboard/weather-dashboard` (port 3000, and `npm start` is port 3002). Do not drive those processes. They use whatever `MONGO_URI` is in the environment or `.env.local`.

## Doctor

```
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs doctor
```

Doctor is read-only. It prints one JSON object and exits 0 only when `ok` is true. Drive the instance only when `ok` is true. Check `url`, `portOwnerPids` (the Next pid or a child of this run; it can differ from `nextPid`), `dashboardVersion`, `nextVersion`, `dbPath` (the empty directory created for this run), `mongoIsolated` true, `regions` (`america`, `asia`, and `europe` each with `cityCount` 1), `utcToday`, `historicalDate`, `datesByCity`, and `liveCities`. `liveCities` is the `/api/live` rows whose `isLive` is true: `city`, `region`, `localDate`, `localTime`. At least one of seattle, london, or tokyo is live for any clock, because their local hours are spread across the 8:00–17:59 capture window.

`problems` lists why the instance is not worth driving. A foreign Next process in this checkout, a dead supervisor, or a region count other than 1 means stop and run `down` before another `up`.

## Drive

Prefer this harness over coordinates, tab order, or a dashboard that was already running. Browser actions go through `browser`. Read-only HTTP checks go through `get`. Both talk only to the origin in the state file.

```
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser open /
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser click --role link --name "america"
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser fill --role textbox --name "Search cities" --value "tokyo"
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Regions"
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Seattle" --exact
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser count --role checkbox --name "tokyo" --eq 1
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser url
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser snapshot --aria --path evidence/browse-regions/home.aria.txt
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser screenshot --path evidence/browse-regions/home.png
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs get /api/regions
```

`click`, `fill`, and `count` require exactly the role and accessible name you pass, except `count`, which prints the match count and fails when `--eq` does not match. A count other than 1 on `click` or `fill` is a failure; the harness does not click the first match. `wait` without `--exact` is case-insensitive. `open` and `get` refuse any URL that is not the verification origin. `snapshot` and `screenshot` refuse paths outside `.cursor/skills/verify-weather-dashboard/evidence/`.

Do not wait for the network to go idle. `/api/stream` stays open on the day page and on Live now.

Stable handles in this app:

- Header links: `Weather Dashboard` (`/`), `Live now` (`/live`), `Stats Explorer` (`/stats`).
- Region cards are links whose accessible name contains the region, for example `america`.
- City cards are links whose accessible name contains the city, for example `seattle`.
- The day page heading is the city name. The forecast caption is `Forecast temp over the day`. The empty day copy is `No ticks recorded for this city/date.`
- Stats city filter: textbox `Search cities`. Dimension chips are buttons, including `City`. The no-dimension copy is `Add at least one dimension above to start exploring.`
- Auto-buy heading is `Auto-buy`. There is no header link to it.

Follow `.cursor/skills/verify-weather-dashboard/features/README.md`, then the feature file for the behavior you are proving. A proof that only opens one convenient URL is incomplete when the map lists other entry points.

## Evidence

Write proof under `.cursor/skills/verify-weather-dashboard/evidence/<feature-id>/`. `down` does not delete that directory.

For a UI proof, capture the action and the resulting state: an ARIA snapshot (`browser snapshot --aria`) and a full-page screenshot (`browser screenshot`) that show the `Weather Dashboard` header. Record the feature id, the entry point, and the `url:` line the snapshot writes. For data the page loaded, also run `get` on the same API the page uses and keep that body. A status message or a screenshot of the final screen is not enough on its own.

Exercise the browser path. `get` is the second view, not a substitute for the click. The price-history cache seeded by `up` is the app's own cache, so a day page does not call `gamma-api.polymarket.com` or `clob.polymarket.com`. If that cache is missing, the route does call Polymarket; do not treat a hung or empty price chart as a temp-chart failure until you have seen the `/api/day/...` body. Do not call `POST /api/automation/tick`. That route is the auto-buy worker.

## Cleanup

```
node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs down
```

`down` shuts down the supervisor started by `up`, then the Next.js pid, the mongod pid, and the Chromium pid recorded for that run. It deletes `.cursor/skills/verify-weather-dashboard/run/` (state, Mongo data path pointer, and `next.log`). It does not delete `.cursor/skills/verify-weather-dashboard/evidence/`. Do not kill `node.exe` or `mongod` by image name. After a failed `up`, run `down` before trying again so a half-written `run/state.json` is not left behind.

## Helpers

The only helper is `scripts/verify-dashboard.mjs`. Invoke it as shown above. `up` stays in the foreground until `down` or Ctrl+C. `doctor` prints JSON. `get <path>` prints `HTTP <status>` and the response body. `browser` subcommands print the page URL, a match count, or the evidence file path.
