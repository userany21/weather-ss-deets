# Stats Explorer

Stats Explorer lets a user slice the seeded feature table. With no dimension selected it asks for one. The City dimension then shows Seattle, and the city search box narrows the checkbox list.

## Sub-features

- `stats-open` opens Stats Explorer from the header.
- `stats-empty` shows the prompt to add a dimension.
- `stats-city` adds the City dimension and shows the Seattle bucket for the ten seeded bets.
- `stats-search` filters the city checkboxes to Tokyo and drops London.

## How to get to it (user POV)

- Choose the `Stats Explorer` link in the header from any page.
- Open `/stats` directly.

## Driving it with verify-dashboard

Preconditions:

- `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs doctor` exits 0.
- Doctor JSON `historicalDate` is the date of the ten seeded `combined` Seattle rows, brackets `50-51°F` through `68-69°F`, all resolved.

- **Header entry.** Start from regions and choose Stats Explorer. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser open /`, `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser click --role link --name "Stats Explorer"`, and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Stats Explorer"`. The URL path is `/stats`.
- **Direct entry.** Open the route. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser open /stats` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Analyze historical and forecasted market data"`. The heading reads `Stats Explorer`.
- **Empty state.** With no dimension selected, run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Add at least one dimension above to start exploring." --exact`. That prompt is visible.
- **City bucket.** Choose the City chip. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser click --role button --name "City"` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Seattle" --exact`. A bucket labeled `Seattle` is visible and the empty-state prompt is gone. The default filters are Combined, minimum sample 10, and resolved markets only; this seed meets them.
- **Search cities.** Type `tokyo` in the city filter. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser fill --role textbox --name "Search cities" --value "tokyo"`, `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser count --role checkbox --name "tokyo" --eq 1`, and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser count --role checkbox --name "london" --eq 0`. The checkbox named `tokyo` is the only city checkbox in the filter. Judge the filter by those checkboxes, not by the Local Times list.
- **Second view.** Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs get "/api/stats?by=city&method=combined&minCount=10&resolvedOnly=1"`. HTTP 200, `total_rows` is 10, and one bucket has label `Seattle` and count 10.
- **Proof.** Capture the City bucket after the search. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser snapshot --aria --path evidence/stats-explorer/city.aria.txt` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser screenshot --path evidence/stats-explorer/city.png`. Both artifacts show `Weather Dashboard`, `Stats Explorer`, and `Seattle`.

## Gotchas

- The default method is Combined, the minimum sample is 10, and `Resolved markets only` starts checked. Fewer than 10 resolved combined rows produces `No buckets meet the minimum sample size.` Do not lower the minimum to make a smaller seed pass.
- `wait --text "Seattle"` without `--exact` also matches the lowercase `seattle` in Local Times and in the city list. Use `--exact` for the bucket label.
- America and Europe start collapsed in the city filter, so their checkboxes are absent until that region is expanded or the search matches. Asia starts expanded.
- The Method `<select>` and the minimum-sample input have no accessible name. The seeded journey does not change them.
- Stats Explorer reads `stats_features`. Ticks in `high-temp` do not create buckets.
- The Local Times panel lists the whole roster even while the search box filters the checkboxes.
- Pinning a bucket and choosing `Auto-buy` calls `/api/automation/rules`. On this instance that request fails closed. That is the Auto-buy journey, not proof of the City bucket.
