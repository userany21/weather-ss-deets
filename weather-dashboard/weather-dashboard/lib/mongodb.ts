// lib/mongodb.ts
import { MongoClient, Db } from "mongodb";

const uri = process.env.MONGO_URI;
if (!uri) {
  throw new Error("Missing MONGO_URI in environment (.env.local)");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let globalWithMongo = global as typeof globalThis & {
  _mongoClientPromise?: Promise<MongoClient>;
};

let clientPromise: Promise<MongoClient>;

if (process.env.NODE_ENV === "development") {
  // Reuse the client across Next.js hot-reloads in dev so we don't leak connections.
  if (!globalWithMongo._mongoClientPromise) {
    const client = new MongoClient(uri);
    globalWithMongo._mongoClientPromise = client.connect();
  }
  clientPromise = globalWithMongo._mongoClientPromise;
} else {
  const client = new MongoClient(uri);
  clientPromise = client.connect();
}

export async function getDb(): Promise<Db> {
  const client = await clientPromise;
  return client.db("weather");
}

export async function getHighTempCollection() {
  const db = await getDb();
  return db.collection("high-temp");
}

export async function getReciprocalCollection() {
  const db = await getDb();
  return db.collection("reciprocal");
}

/**
 * Stores trimmed Polymarket bracket price histories per (city, date) so we
 * avoid re-fetching the full UTC day from the CLOB API on every revalidation.
 * Historical days are cached permanently; today's entries include a cachedAt
 * field that the route uses to decide whether to refresh.
 */
export async function getPriceHistoryCacheCollection() {
  const db = await getDb();
  return db.collection("price-history-cache");
}
