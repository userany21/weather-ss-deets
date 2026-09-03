# weather-dashboard

Next.js (App Router) drilldown dashboard for the `weather.high-temp` Mongo
collection populated by the `weather-ss-deets` screenshot bot.

Region → City → Date → temp curve + market price curve (recharts), plus a
`/live` page that shows every city currently inside its 8am–6pm local
capture window, auto-refreshing every 60s.

Intended to live as a sibling folder inside the `weather-ss-deets` repo,
e.g. `weather-ss-deets/dashboard/`.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in MONGO_URI (same DB the screenshot bot writes to)
npm run dev                  # http://localhost:3000
```

## How it maps to analyze_weather.py

- `lib/weather-transform.ts` is a direct TS port of the `paced_at` construction
  and `make_bracket_labeler` logic from `analyze_weather.py` — same math, no
  pandas. If you change the bracket-labeling rules in the Python script, mirror
  the change here too (or better: retire the Python script's chart generation
  entirely and keep only its `summary` command, since this app replaces the
  `day` command's charts with live recharts versions).
- `lib/cities-config.ts` mirrors the `CITIES` roster + cadence groups already
  defined in `screenshot.js`. Keep both in sync if the roster changes — this
  is the one piece of manual duplication between the scraper and the dashboard.

## Deploying alongside the scraper

On the droplet, this can run as its own PM2 process next to the screenshot
bot and any other services:

```bash
cd weather-ss-deets/dashboard
npm install
npm run build
pm2 start npm --name weather-dashboard -- start   # serves on :3001, see package.json
```

Put it behind whatever reverse proxy (nginx/Caddy) you're already using for
other services on the droplet, or just hit `<droplet-ip>:3001` directly if
this is for personal use only.

## Live updates

`/api/stream` opens a MongoDB **change stream** on `weather.high-temp` and
pushes an SSE event (`{ city, local_date, pacing_time }`) the instant a new
tick is inserted. The day-drilldown page and every card on `/live` subscribe
to this and refetch their own `/api/day/:city/:date` data only when an event
matches their city + date — so charts update within roughly a second of the
screenshot bot posting a new tick, no fixed polling interval to tune.

**This requires the Mongo deployment to support change streams**, i.e. a
replica set. Atlas clusters are replica sets by default, so if you're on
Atlas this just works. If you're ever on a standalone `mongod`, `.watch()`
will throw on first use — a 5-minute background poll is kept as a fallback in
both places so the dashboard still eventually catches up, just not instantly.

## Notes / next steps

- The `/live` window (8am–6pm local) and per-city timezones are hardcoded in
  `cities-config.ts`, matching what's already established for the screenshot
  bot's polling cadence. If that roster grows, add cities there.
- The list of *which* cities are currently live (`/api/live`) is still on a
  60s poll — that's just a window-check, not tick data, so instant updates
  don't matter there.
- No auth on any of this — fine for local/private use behind your own
  network, but add something in front of it before exposing it publicly.
- If this ever sits behind an nginx/Caddy reverse proxy, make sure proxy
  buffering is disabled for `/api/stream` (`proxy_buffering off;` in nginx)
  or the SSE events will get stuck in a buffer instead of arriving live.
