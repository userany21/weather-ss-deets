# Browse regions

Browse regions lets a user open the dashboard, pick a region that has captured ticks, pick a city, and see that city's forecast for the UTC date the app redirects to.

## Sub-features

- `regions-home` shows America, Asia, and Europe with a city count taken from cities that have ticks.
- `regions-open` lists the cities in the chosen region.
- `regions-day` opens a city and shows the forecast caption for the UTC date.
- `regions-api` returns the same city from `/api/cities/america` and the same ticks from `/api/day/seattle/<utcToday>`.

## How to get to it (user POV)

- Open `/`. The header link `Weather Dashboard` also goes to `/`.
- Choose the region card, for example `america`.
- Choose the city card, for example `seattle`. The app redirects `/america/seattle` to `/america/seattle/<UTC today>`.

## Driving it with verify-dashboard

Preconditions:

- `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs doctor` exits 0.
- Doctor JSON `regions` lists `america`, `asia`, and `europe` with `cityCount` 1.
- Doctor JSON `utcToday` is the date the city card opens. `datesByCity.seattle` includes that date.

- **Open home.** Go to the regions page. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser open /` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Regions"`. The `Weather Dashboard` header is visible and the page shows a link whose name contains `america`.
- **Home proof.** Capture the regions page before leaving it. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser snapshot --aria --path evidence/browse-regions/home.aria.txt` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser screenshot --path evidence/browse-regions/home.png`. Both artifacts show `Weather Dashboard`, `Regions`, and `america`.
- **Open America.** Choose the America card. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser click --role link --name "america"` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "america cities"`. The heading reads `america cities` and a link whose name contains `seattle` is visible.
- **Open Seattle.** Choose the Seattle card. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser click --role link --name "seattle"`, `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Forecast temp over the day"`, and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser url`. The URL path is `/america/seattle/<utcToday from doctor>`. The page does not show `No ticks recorded for this city/date.`
- **Second view.** Read the APIs the pages used. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs get /api/cities/america` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs get /api/day/seattle/<utcToday from doctor>`. Both return HTTP 200. The cities body includes `seattle`. The day body has a non-empty `ticks` array.
- **Day proof.** Capture the forecast. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser snapshot --aria --path evidence/browse-regions/day.aria.txt` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser screenshot --path evidence/browse-regions/day.png`. Both artifacts show `Weather Dashboard`, `seattle`, and `Forecast temp over the day`.

## Gotchas

- City cards redirect to the UTC date, not the city's local date. If `datesByCity.seattle` does not include `utcToday`, the day page shows `No ticks recorded for this city/date.` and this journey fails.
- The home and region pages server-fetch `NEXT_PUBLIC_BASE_URL`. The harness sets that to the verification origin. A server on port 3000 is a different instance.
- A region whose seeded city count is 0 renders Next.js not-found, not an empty grid.
- The America card's accessible name includes the city count, for example `america 1 cities`. Pass `--name "america"` and require one match.
- `/api/prices-history` calls Polymarket when `price-history-cache` has no document for that city and date. `up` seeds an empty cache so this journey does not use the network. A missing cache can make the price section slow without removing the forecast caption.
- `/api/stream` stays connected on the day page. Do not wait for the network to go idle.
