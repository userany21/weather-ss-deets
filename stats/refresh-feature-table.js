/**
 * stats/refresh-feature-table.js
 *
 * Nightly cron wrapper for build-feature-table.js.
 *
 * Recomputes the last 7 days of the stats_features collection so that:
 *   - City-days that were unresolved at the time of the previous build (no
 *     winning_bracket yet) get re-evaluated now that outcomes may have landed.
 *   - Tick data added late (e.g. backfills) is reflected.
 *
 * Historical rows older than 7 days are left untouched. To force a full
 * reprocessing of all history, run build-feature-table.js --force manually.
 *
 * Suggested schedule (crontab / n8n):
 *   0 1 * * *   MONGO_URI="..." node /path/to/refresh-feature-table.js
 *   (1:00 AM server time — market data for all timezones should be final by then)
 *
 * Exit codes:
 *   0 — success
 *   1 — build-feature-table.js exited with an error
 */

const { execFileSync } = require("child_process");
const path = require("path");

const BUILDER = path.join(__dirname, "build-feature-table.js");
const DAYS = process.env.REFRESH_DAYS ?? "7";

// The builder is a DRY RUN unless --apply is passed. This wrapper only forwards --apply when it
// is asked to (its own --apply argument, or REFRESH_APPLY=1), so deploying new code can never
// start writing by surprise. After cutover, add --apply (or REFRESH_APPLY=1) to the cron job.
const APPLY =
  process.argv.slice(2).includes("--apply") || process.env.REFRESH_APPLY === "1";
const builderArgs = [BUILDER, `--days=${DAYS}`];
if (APPLY) builderArgs.push("--apply");

console.log(
  `[refresh-feature-table] ${new Date().toISOString()} — running builder --days=${DAYS}` +
    (APPLY ? " --apply" : " (DRY RUN: pass --apply or set REFRESH_APPLY=1 to write)")
);

try {
  execFileSync(process.execPath, builderArgs, {
    stdio: "inherit",
    env: process.env,
  });
  console.log(`[refresh-feature-table] Done.`);
} catch (err) {
  console.error(`[refresh-feature-table] Builder failed:`, err.message ?? err);
  process.exit(1);
}
