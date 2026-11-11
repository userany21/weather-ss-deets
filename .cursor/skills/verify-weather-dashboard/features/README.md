# Weather dashboard verification map

This directory is the maintained source for verifying the user-facing behavior of weather-dashboard. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Run commands from the repo root.
- Launch with `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs up` and wait for `READY url=http://127.0.0.1:4173` (or the `VERIFY_PORT` you set).
- The data directory is the empty `dbPath` created for this run. Do not point the browser at port 3000 or 3002.
- Seeded cities are `seattle` (america), `london` (europe), and `tokyo` (asia). `doctor` prints `utcToday`, `historicalDate`, `datesByCity`, and `liveCities`.
- Run `doctor` and require `ok: true`, the expected URL, a port owner from this run, and `mongoIsolated: true`.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names. The harness fails a click when more than one element matches.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `verify-dashboard.mjs browser`.
- Run HTTP checks through `verify-dashboard.mjs get`.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with `Weather Dashboard` visible.
- HTTP proof includes the status line and the body from `get`.
- Record the feature id and the entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-dashboard` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Browse regions](./browse-regions.md) covers the header home link, region cards, city cards, and the UTC-today forecast.
- [Live now](./live-now.md) covers the header entry and the cities inside the 8:00–17:59 local capture window.
- [Stats Explorer](./stats-explorer.md) covers the header entry, the empty dimension prompt, the City bucket, and city search.
- [Auto-buy](./auto-buy.md) covers the admin page. The disposable instance does not satisfy its auth precondition.
