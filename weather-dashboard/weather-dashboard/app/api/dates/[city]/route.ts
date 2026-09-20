import { NextResponse } from "next/server";
import { getHighTempCollection } from "@/lib/mongodb";

export async function GET(_req: Request, { params }: { params: { city: string } }) {
  const city = decodeURIComponent(params.city).toLowerCase();
  const collection = await getHighTempCollection();

  const [dates, aggResult] = await Promise.all([
    collection.distinct("local_date", { city }),
    collection.aggregate([
      { $match: { city } },
      { $group: { _id: "$local_date", ticksOnDay: { $sum: 1 } } },
      { $group: { _id: null, avgTicksPerDay: { $avg: "$ticksOnDay" }, totalDays: { $sum: 1 } } },
    ]).toArray(),
  ]);

  dates.sort().reverse(); // most recent first

  const stats = aggResult[0] as { avgTicksPerDay: number; totalDays: number } | undefined;

  return NextResponse.json({
    city,
    dates,
    avgTicksPerDay: stats?.avgTicksPerDay ?? null,
    totalDays: stats?.totalDays ?? 0,
  });
}
