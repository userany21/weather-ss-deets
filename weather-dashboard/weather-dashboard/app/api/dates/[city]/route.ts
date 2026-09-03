import { NextResponse } from "next/server";
import { getHighTempCollection } from "@/lib/mongodb";

export async function GET(_req: Request, { params }: { params: { city: string } }) {
  const city = decodeURIComponent(params.city).toLowerCase();
  const collection = await getHighTempCollection();

  const dates: string[] = await collection.distinct("local_date", { city });
  dates.sort().reverse(); // most recent first

  return NextResponse.json({ city, dates });
}
