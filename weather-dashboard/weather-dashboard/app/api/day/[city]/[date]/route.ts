import { NextResponse } from "next/server";
import { getHighTempCollection } from "@/lib/mongodb";
import { enrichDay, Tick } from "@/lib/weather-transform";

export async function GET(
  _req: Request,
  { params }: { params: { city: string; date: string } }
) {
  const city = decodeURIComponent(params.city).toLowerCase();
  const date = params.date;

  const collection = await getHighTempCollection();
  const docs = (await collection
    .find({ city, local_date: date })
    .sort({ captured_at: 1 })
    .toArray()) as unknown as Tick[];

  if (docs.length === 0) {
    return NextResponse.json({ city, date, ticks: [] });
  }

  const { ticks, winningLow, winningHigh, winningBracket, unit } = enrichDay(docs);

  return NextResponse.json({
    city,
    date,
    unit,
    winningLow,
    winningHigh,
    winningBracket,
    ticks,
  });
}
