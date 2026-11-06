import { MongoClient, type Db } from "mongodb";
import type { TickLite } from "./engine";

/**
 * Own small Mongo client for the automation worker (database "weather").
 * Kept separate from lib/mongodb.ts so this feature does not depend on its export names.
 */

const g = globalThis as unknown as { __wxAutoMongo?: Promise<MongoClient> };

export async function getWeatherDb(): Promise<Db> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  if (!g.__wxAutoMongo) {
    g.__wxAutoMongo = new MongoClient(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 8000 })
      .connect()
      .catch((err) => {
        g.__wxAutoMongo = undefined;
        throw err;
      });
  }
  return (await g.__wxAutoMongo).db("weather");
}

export type TickMethod = "combined" | "linear" | "reciprocal" | "all";

export interface TickDoc extends TickLite {
  city: string;
  source: "linear" | "reciprocal";
}

/** Today's ticks for one city, from the collections the method needs. `high-temp` is linear. */
export async function loadTodayTicks(city: string, localDate: string, method: TickMethod): Promise<TickDoc[]> {
  const db = await getWeatherDb();
  const sources: Array<["linear" | "reciprocal", string]> = [];
  if (method !== "reciprocal") sources.push(["linear", "high-temp"]);
  if (method !== "linear") sources.push(["reciprocal", "reciprocal"]);

  const out: TickDoc[] = [];
  for (const [source, collection] of sources) {
    const docs = await db
      .collection(collection)
      .find(
        { city, local_date: localDate },
        { projection: { _id: 0, city: 1, pacing_time: 1, captured_at: 1, bracket: 1, yes_price_cents: 1, yes_price: 1 } },
      )
      .sort({ captured_at: 1 })
      .limit(500)
      .toArray();
    for (const d of docs) {
      out.push({
        city: String(d.city),
        source,
        pacing_time: String(d.pacing_time ?? ""),
        captured_at: d.captured_at as Date | string,
        bracket: d.bracket == null ? null : String(d.bracket),
        yes_price_cents: d.yes_price_cents == null ? null : Number(d.yes_price_cents),
        yes_price: d.yes_price == null ? null : Number(d.yes_price),
      });
    }
  }
  return out;
}

/** The winning bracket the hourly winner job tagged on that city-day, or null while it is untagged. */
export async function loadWinningBracket(city: string, localDate: string): Promise<string | null> {
  const db = await getWeatherDb();
  const doc = await db
    .collection("high-temp")
    .findOne(
      { city, local_date: localDate, winning_bracket: { $exists: true, $nin: [null, ""] } },
      { projection: { _id: 0, winning_bracket: 1 } },
    );
  return doc && typeof doc.winning_bracket === "string" ? doc.winning_bracket : null;
}
