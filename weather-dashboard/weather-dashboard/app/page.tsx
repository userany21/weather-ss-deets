import Link from "next/link";

type RegionRow = { region: string; cityCount: number };

async function getRegions(): Promise<RegionRow[]> {
  // Fetch from our API route which now counts cities from Mongo.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/regions`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return data.regions ?? [];
}

export default async function HomePage() {
  const regions = await getRegions();

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Regions</h1>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
        {regions.map(({ region, cityCount }) => (
          <Link key={region} href={`/${region}`} className="card">
            <div className="text-lg capitalize">{region}</div>
            <div className="text-subtext text-sm">{cityCount} cities</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
