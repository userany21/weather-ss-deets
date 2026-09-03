import { NextResponse } from "next/server";
import { enrichCity } from "@/lib/cities-config";
import { getHighTempCollection } from "@/lib/mongodb";

export async function GET(_req: Request, { params }: { params: { region: string } }) {
  const region = params.region.toLowerCase();
  const collection = await getHighTempCollection();

  // Pull distinct cities for this region from Mongo, along with the timezone
  // stored on the most-recent document for each city (written by the poll scripts).
  const pipeline = [
    { $match: { region } },
    { $sort: { captured_at: -1 } },
    {
      $group: {
        _id: "$city",
        timezone: { $first: "$timezone" },
        region: { $first: "$region" },
      },
    },
    { $sort: { _id: 1 } },
  ];

  type CityRow = { _id: string; timezone?: string; region?: string };
  const rows: CityRow[] = await collection.aggregate(pipeline).toArray() as CityRow[];

  if (rows.length === 0) {
    return NextResponse.json({ error: "Unknown region" }, { status: 404 });
  }

  const cities = rows
    .map((r) => enrichCity(r._id, r.region, r.timezone))
    .filter(Boolean);

  return NextResponse.json({ region, cities });
}
