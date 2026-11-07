// Read-only check of the closing-tick table against the ticks actually stored in Mongo.
// Run from weather-dashboard/weather-dashboard:
//   MONGO_URI=... node scripts/verify-closing-ticks.mjs [bucket]    closing ticks. bucket 3 = the 11AM hour (default)
//   MONGO_URI=... node scripts/verify-closing-ticks.mjs first       the first-prediction tick of the day
// It never writes. A MISSING line means the schedule in lib/automation/engine.js is wrong for that city.
import { createRequire } from "node:module";
import { MongoClient } from "mongodb";

const require = createRequire(import.meta.url);
const eng = require("../lib/automation/engine.js");

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("Set MONGO_URI first.");
  process.exit(1);
}
const mode = process.argv[2] ?? "3";
const firstMode = mode === "first";
const bucket = firstMode ? 0 : Number(mode);
const hour24 = bucket + eng.FIRST_HOUR24;

const client = new MongoClient(uri);
await client.connect();
const db = client.db("weather");

let problems = 0;
console.log(
  firstMode
    ? "First-prediction check, last 3 local days\n"
    : `Closing-tick check for the ${eng.formatLabel(hour24, 0).replace(":00", "")} hour (bucket ${bucket}), last 3 local days\n`,
);

for (const [city, sched] of Object.entries(eng.CITY_SCHEDULE)) {
  const win = eng.FIRST_TICK_WINDOW[city];
  const closeMin = firstMode ? null : eng.closingMinute(city);
  const expected = firstMode
    ? eng.formatLabel(Math.floor(win[0] / 60), win[0] % 60) + (win[1] > win[0] ? ` to ${eng.formatLabel(Math.floor(win[1] / 60), win[1] % 60)}` : "")
    : eng.formatLabel(hour24, closeMin);
  const dates = [0, 1, 2].map((i) => eng.localParts(new Date(Date.now() - i * 86_400_000), sched.tz).date);

  for (const date of dates) {
    const minutes = new Map(); // minute -> earliest captured_at
    for (const coll of ["high-temp", "reciprocal"]) {
      const docs = await db
        .collection(coll)
        .find({ city, local_date: date }, { projection: { _id: 0, pacing_time: 1, captured_at: 1 } })
        .toArray();
      for (const d of docs) {
        const p = eng.parsePacingTime(d.pacing_time);
        if (!p) continue;
        if (firstMode) {
          if (p.hour24 < 8 || p.hour24 > 9) continue;
        } else if (p.hour24 !== hour24) continue;
        const cap = new Date(d.captured_at).getTime();
        const prev = minutes.get(p.minute);
        if (prev === undefined || cap < prev) minutes.set(p.minute, cap);
      }
    }
    const observed = [...minutes.keys()].sort((a, b) => a - b);
    if (observed.length === 0) {
      console.log(`${city.padEnd(14)} ${date}  no ticks in this hour`);
      continue;
    }
    let hit;
    let lag = "";
    if (firstMode) {
      // keys are minutes of the hour inside hours 8 and 9, so rebuild minute-of-day from the labels seen
      const labels = [];
      for (const coll of ["high-temp", "reciprocal"]) {
        const docs = await db.collection(coll).find({ city, local_date: date }, { projection: { _id: 0, pacing_time: 1 } }).toArray();
        for (const d of docs) {
          const p = eng.parsePacingTime(d.pacing_time);
          if (p) labels.push(p.hour24 * 60 + p.minute);
        }
      }
      hit = labels.some((m) => m >= win[0] && m <= win[1]);
    } else {
      // Same rule as gate(): last tick in this hour at or after the nominal close.
      const items = [...minutes.entries()].map(([minute, cap]) => ({ p: { hour24, minute }, cap }));
      const picked = eng.pickClosingTicks(items, hour24, closeMin);
      hit = picked.length > 0;
      if (hit) {
        const labelMin = picked[0].p.minute;
        const lp = eng.localParts(new Date(picked[0].cap), sched.tz);
        lag = `  stored ${lp.hour * 60 + lp.minute - (hour24 * 60 + labelMin)} min after its label`;
      } else {
        // Suggest what the schedule should say: the largest minute that was really seen in this hour.
        lag = `  (last minute seen is :${String(observed[observed.length - 1]).padStart(2, "0")}, set the schedule to match)`;
      }
    }
    if (!hit) problems++;
    console.log(
      `${city.padEnd(14)} ${date}  seen :${observed.map((m) => String(m).padStart(2, "0")).join(" :")}  expected ${firstMode ? "first prediction" : "close"} ${expected}  ${hit ? "OK" + lag : "MISSING" + lag}`,
    );
  }
}

const today = [0, 1].map((i) => eng.localParts(new Date(Date.now() - i * 86_400_000), "UTC").date);
const seen = await db.collection("high-temp").distinct("city", { local_date: { $in: today } });
const unknown = seen.filter((c) => eng.scheduleFor(c) === null || String(c) !== String(c).toLowerCase());
if (unknown.length > 0) {
  problems++;
  console.log(`\nCity names in Mongo that do not match the lowercase schedule keys: ${unknown.join(", ")}`);
}

await client.close();
console.log(problems === 0 ? "\nAll closing ticks found." : `\n${problems} problem(s). Fix the schedule table in engine.js or the data before turning anything on.`);
process.exit(problems === 0 ? 0 : 2);
