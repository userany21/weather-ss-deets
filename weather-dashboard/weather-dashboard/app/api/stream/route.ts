import { getHighTempCollection } from "@/lib/mongodb";

// Change streams require a long-lived connection and push data as it
// arrives — Next.js needs to know not to buffer/cache this route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Watches for new tick inserts on weather.high-temp and pushes a tiny
 * notification (city + local_date + pacing_time) down to any connected
 * client via SSE. Clients use this purely as a "go refetch" signal — the
 * actual enriched chart data still comes from /api/day/:city/:date, so the
 * paced_at/bracket logic only lives in one place.
 *
 * Requires the Mongo deployment to support change streams (i.e. a replica
 * set — Atlas clusters are one by default). On a standalone mongod this
 * route will error on first change and clients fall back to slow polling.
 */
export async function GET() {
  const collection = await getHighTempCollection();
  const changeStream = collection.watch(
    [{ $match: { operationType: "insert" } }],
    { fullDocument: "updateLookup" }
  );

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Keep intermediary proxies/browsers from timing out an idle connection.
      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 25_000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      changeStream.on("change", (change: any) => {
        const doc = change.fullDocument;
        if (!doc) return;
        send({
          city: doc.city,
          local_date: doc.local_date,
          pacing_time: doc.pacing_time ?? null,
        });
      });

      changeStream.on("error", (err) => {
        console.error("weather change stream error:", err);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      clearInterval(heartbeat);
      changeStream.close().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
