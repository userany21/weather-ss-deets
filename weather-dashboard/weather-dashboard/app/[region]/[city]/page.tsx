import { redirect } from "next/navigation";

export default function CityPage({
  params,
}: {
  params: { region: string; city: string };
}) {
  // Skip the dates grid — go straight to today's data.
  const today = new Date().toISOString().slice(0, 10);
  redirect(`/${params.region}/${params.city}/${today}`);
}
