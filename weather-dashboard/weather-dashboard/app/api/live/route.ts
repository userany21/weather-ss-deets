import { NextResponse } from "next/server";
import { enrichCity, getLiveStatus } from "@/lib/cities-config";
import { getHighTempCollection } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function GET() {
  const collection = await getHighTempCollection();

  // Discover all cities (+ their region/timezone) from Mongo so newly-polled
  // cities appear on the live page without any config changes.
  const pipeline = [
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

  const now = new Date();
  const cities = rows
    .map((r) => {
      const cfg = enrichCity(r._id, r.region, r.timezone);
      if (!cfg) return null;
      const status = getLiveStatus(cfg, now);
      return {
        city: cfg.city,
        region: cfg.region,
        cadenceMinutes: cfg.cadenceMinutes,
        ...status,
      };
    })
    .filter(Boolean);

  return NextResponse.json({ generatedAt: now.toISOString(), cities });
}
