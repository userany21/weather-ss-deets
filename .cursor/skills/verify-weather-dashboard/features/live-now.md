# Live now

Live now lists every seeded city whose local time is inside the 8:00–17:59 capture window and links each panel to that city's local date.

## Sub-features

- `live-open` opens the page from the header.
- `live-list` shows each city in doctor `liveCities` and hides cities outside the window.
- `live-ticks` loads today's ticks for the city's local date, not the UTC date.
- `live-api` returns the same live set from `/api/live` and the same ticks from `/api/day/<city>/<localDate>`.

## How to get to it (user POV)

- Choose the `Live now` link in the header from any page.
- Open `/live` directly.

## Driving it with verify-dashboard

Preconditions:

- `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs doctor` exits 0.
- Doctor JSON `liveCities` has at least one entry. Each entry has `city`, `region`, and `localDate`.
- `datesByCity` for that city includes `localDate`.

- **Header entry.** Start from regions, then choose Live now. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser open /`, `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser click --role link --name "Live now"`, and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Live now"`. The URL path is `/live` and the heading reads `Live now`.
- **Direct entry.** Open the route. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser open /live` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Cities currently inside their 8am–6pm local capture window"`. The same heading is visible.
- **Live cities.** For every object in doctor `liveCities`, run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "<city>"` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser count --role link --name "<city>" --eq 1`. Each matching link is that city's panel. The page does not show `No cities currently in their capture window.`
- **Second view.** Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs get /api/live`. HTTP 200, and every `isLive` city matches doctor `liveCities`. For each of those cities, run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs get /api/day/<city>/<localDate>`. HTTP 200 and `ticks` is non-empty.
- **Proof.** Capture the list. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser snapshot --aria --path evidence/live-now/live.aria.txt` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser screenshot --path evidence/live-now/live.png`. Both artifacts show `Weather Dashboard`, `Live now`, and every city in doctor `liveCities`.

## Gotchas

- A city is live when its local hour is 8 through 17. Doctor recomputes this from the clock. If the page shows `No cities currently in their capture window.` while doctor `liveCities` is non-empty, the journey fails.
- The panel links to `/<region>/<city>/<localDate>`. That local date can differ from `utcToday`, which is the date a city card on the regions page redirects to.
- Only cities with at least one `high-temp` document appear. The static roster in the clock panel on Stats Explorer is not this list.
- The page keeps `/api/stream` open. Do not wait for the network to go idle.
- The panel's accessible name includes the city and the local time. Match on the city and require one link.
