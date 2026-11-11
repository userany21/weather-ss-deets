# Auto-buy

Auto-buy lets a signed-in admin review saved rows, see an empty list, and switch a row on. Saving starts from a pinned Stats Explorer bucket.

## Sub-features

- `autobuy-open` opens the admin page.
- `autobuy-empty` shows `Saved rows` and, when no rule exists, `Nothing saved yet.`
- `autobuy-arm` saves the pinned Stats Explorer bucket and links to this page to switch it on.

## How to get to it (user POV)

- Open `/admin/automation`.
- On Stats Explorer, pin a bucket, choose `Auto-buy`, then choose `Saved. Switch on` or `Already saved`. Both links go to `/admin/automation`.
- There is no `Auto-buy` link in the header.

## Driving it with verify-dashboard

Preconditions:

- `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs doctor` exits 0.
- Admin auth is configured for this origin: Cloudflare Access (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `AUTOMATION_ADMIN_EMAILS`) or, for a non-production server, `AUTOMATION_DEV_BYPASS=1` plus a Supabase project the page can read. The disposable `up` process sets `AUTOMATION_ENABLED=false` and blanks those variables on purpose.

- **Direct entry.** Open the admin page. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser open /admin/automation` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Auto-buy"`. The heading reads `Auto-buy`.
- **Saved rows.** Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser wait --text "Nothing saved yet." --exact`. That sentence is the empty-state proof. A table of rules is the proof when a row was saved earlier in the same run.
- **Second view.** Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs get /api/automation/rules`. HTTP 200 and a JSON `rules` array. An empty array matches `Nothing saved yet.`
- **Stats entry.** This entry needs a pinned bucket. Drive [Stats Explorer](./stats-explorer.md) through the City bucket, pin `Seattle`, choose `Auto-buy`, then choose `Saved. Switch on`. The browser lands on `/admin/automation` and the new row is visible. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs get /api/automation/rules` again and require that row in `rules`.
- **Proof.** Capture the saved-rows state, empty or populated. Run `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser snapshot --aria --path evidence/auto-buy/rows.aria.txt` and `node .cursor/skills/verify-weather-dashboard/scripts/verify-dashboard.mjs browser screenshot --path evidence/auto-buy/rows.png`. Both artifacts show `Auto-buy` and `Saved rows`.

The disposable instance fails this journey at **Saved rows**. `up` blanks Cloudflare Access and Supabase, so the page shows `Admin access is not configured` and `get /api/automation/rules` returns HTTP 503. Report that unmet precondition. Do not count the error banner as a passed empty state, and do not point the browser at another origin to reach a real admin session.

## Gotchas

- `requireAdmin` returns 503 `Admin access is not configured` when the Access settings are missing. `AUTOMATION_DEV_BYPASS=1` is ignored when `NODE_ENV` is `production`. The harness never sets the bypass.
- `AUTOMATION_ENABLED=false` makes the page say `Worker is off on the server` after auth succeeds. That badge is not proof that a row was saved.
- Do not call `POST /api/automation/tick`. That runs the worker.
- The `Auto-buy` control on Stats Explorer is a button with no accessible name beyond the visible text `Auto-buy`. It is absent until a bucket is pinned.
- A failed save surfaces as `Open /admin/automation and sign in first` or the API error. That is not `Saved. Switch on`.
