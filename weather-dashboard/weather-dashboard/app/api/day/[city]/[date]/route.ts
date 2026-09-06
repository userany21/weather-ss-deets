import { NextResponse } from "next/server";
import { getHighTempCollection, getReciprocalCollection } from "@/lib/mongodb";
import { enrichDay, Tick } from "@/lib/weather-transform";

export async function GET(
  _req: Request,
  { params }: { params: { city: string; date: string } }
) {
  const city = decodeURIComponent(params.city).toLowerCase();
  const date = params.date;

  // Fetch both collections in parallel — same connection, no extra TCP overhead.
  const [linearCol, reciprocalCol] = await Promise.all([
    getHighTempCollection(),
    getReciprocalCollection(),
  ]);

  const [linearDocs, reciprocalDocs] = await Promise.all([
    linearCol.find({ city, local_date: date }).sort({ captured_at: 1 }).toArray(),
    reciprocalCol.find({ city, local_date: date }).sort({ captured_at: 1 }).toArray(),
  ]);

  if (linearDocs.length === 0 && reciprocalDocs.length === 0) {
    return NextResponse.json({ city, date, ticks: [], reciprocalTicks: [] });
  }

  const linear = linearDocs.length > 0
    ? enrichDay(linearDocs as unknown as Tick[])
    : { ticks: [], winningLow: null, winningHigh: null, winningBracket: null, unit: "C" as const };

  const reciprocal = reciprocalDocs.length > 0
    ? enrichDay(reciprocalDocs as unknown as Tick[])
    : { ticks: [] };

  return NextResponse.json({
    city,
    date,
    unit: linear.unit,
    winningLow: linear.winningLow,
    winningHigh: linear.winningHigh,
    winningBracket: linear.winningBracket,
    ticks: linear.ticks,
    reciprocalTicks: reciprocal.ticks,
  });
}
