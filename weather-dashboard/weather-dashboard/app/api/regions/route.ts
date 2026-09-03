import { NextResponse } from "next/server";
import { REGIONS, Region } from "@/lib/cities-config";
import { getHighTempCollection } from "@/lib/mongodb";

export async function GET() {
  const collection = await getHighTempCollection();

  // Count distinct cities per region directly from Mongo so newly-polled
  // cities are reflected here without any config changes.
  const pipeline = [
    { $group: { _id: { city: "$city", region: "$region" } } },
    { $group: { _id: "$_id.region", cityCount: { $sum: 1 } } },
  ];
  const mongoCounts: { _id: string; cityCount: number }[] = await collection
    .aggregate(pipeline)
    .toArray() as { _id: string; cityCount: number }[];

  const mongoMap = new Map(mongoCounts.map((r) => [r._id, r.cityCount]));

  // Include all known regions; fall back to 0 if Mongo has no docs for one yet.
  const regions = REGIONS.map((region) => ({
    region,
    cityCount: mongoMap.get(region) ?? 0,
  }));

  // Also surface any regions that appear in Mongo but aren't in the static list.
  for (const { _id, cityCount } of mongoCounts) {
    if (_id && !REGIONS.includes(_id as never)) {
      regions.push({ region: _id as Region, cityCount });
    }
  }

  return NextResponse.json({ regions });
}
