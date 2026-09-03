import { NextResponse } from "next/server";
import { REGIONS, CITIES } from "@/lib/cities-config";
import { getHighTempCollection } from "@/lib/mongodb";

export async function GET() {
  const collection = await getHighTempCollection();

  // Get distinct city names that actually have data in Mongo.
  const citiesWithData: string[] = await collection.distinct("city");
  const citySet = new Set(citiesWithData.map((c) => c.toLowerCase()));

  // Count how many cities per region have data, using the static config to
  // map city → region (documents don't carry a region field).
  const counts = new Map<string, number>();
  for (const cfg of CITIES) {
    if (citySet.has(cfg.city)) {
      counts.set(cfg.region, (counts.get(cfg.region) ?? 0) + 1);
    }
  }

  const regions = REGIONS.map((region) => ({
    region,
    cityCount: counts.get(region) ?? 0,
  }));

  return NextResponse.json({ regions });
}
