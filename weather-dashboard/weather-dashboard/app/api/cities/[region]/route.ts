import { NextResponse } from "next/server";
import { citiesInRegion, enrichCity } from "@/lib/cities-config";
import { getHighTempCollection } from "@/lib/mongodb";

export async function GET(_req: Request, { params }: { params: { region: string } }) {
  const region = params.region.toLowerCase();

  // Get the city list for this region from the static config.
  const configCities = citiesInRegion(region);
  if (configCities.length === 0) {
    return NextResponse.json({ error: "Unknown region" }, { status: 404 });
  }

  const collection = await getHighTempCollection();

  // Find which of those cities actually have data in Mongo.
  const cityNames = configCities.map((c) => c.city);
  const citiesWithData: string[] = await collection.distinct("city", {
    city: { $in: cityNames },
  });
  const dataSet = new Set(citiesWithData.map((c) => c.toLowerCase()));

  // Return all config cities for this region, filtered to those with data.
  const cities = configCities
    .filter((c) => dataSet.has(c.city))
    .map((c) => enrichCity(c.city, c.region, c.timezone))
    .filter(Boolean);

  if (cities.length === 0) {
    return NextResponse.json({ error: "Unknown region" }, { status: 404 });
  }

  return NextResponse.json({ region, cities });
}
