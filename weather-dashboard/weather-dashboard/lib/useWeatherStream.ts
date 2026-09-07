"use client";

import { useEffect, useRef } from "react";

export interface TickEvent {
  city: string;
  local_date: string;
  pacing_time: string | null;
}

// ---------------------------------------------------------------------------
// Module-level singleton — ONE EventSource shared across every component that
// calls useWeatherStream, regardless of how many mount simultaneously.
//
// Why a singleton?
//   Each browser tab was previously opening N connections to /api/stream
//   (one per LiveCityPanel). The server holds a MongoDB change-stream cursor
//   per SSE client, so N panels = N cursors. With a singleton we always have
//   exactly ONE connection and ONE server-side cursor, no matter how many
//   panels are rendered.
//
// Lifecycle:
//   - First subscriber → EventSource is created and connected.
//   - Additional subscribers → registered into the same Set; no new connection.
//   - Last subscriber unmounts → EventSource is closed and nulled so the next
//     mount starts fresh (handles page navigation / hot-reload cleanly).
// ---------------------------------------------------------------------------
let sharedEs: EventSource | null = null;
const subscribers = new Set<(evt: TickEvent) => void>();

function ensureConnected(): void {
  if (sharedEs) return;
  sharedEs = new EventSource("/api/stream");

  sharedEs.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data) as TickEvent;
      // Dispatch to every registered subscriber
      subscribers.forEach((cb) => cb(data));
    } catch {
      // Heartbeat comments and malformed payloads are silently ignored
    }
  };

  sharedEs.onerror = () => {
    // EventSource reconnects automatically on transient errors.
    // If it enters CLOSED state (e.g. server restart), the next subscriber
    // mount will create a fresh connection.
    if (sharedEs?.readyState === EventSource.CLOSED) {
      sharedEs = null;
    }
  };
}

function teardown(): void {
  sharedEs?.close();
  sharedEs = null;
}

// ---------------------------------------------------------------------------
// Public hook — API is identical to the original so all call-sites are
// unchanged. The caller just provides a callback; connection management is
// handled transparently by the singleton above.
// ---------------------------------------------------------------------------
export function useWeatherStream(onTick: (event: TickEvent) => void) {
  // Keep a stable ref so the subscriber closure always calls the latest
  // version of onTick without needing to re-register on every render.
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    const cb = (evt: TickEvent) => onTickRef.current(evt);

    subscribers.add(cb);
    ensureConnected();

    return () => {
      subscribers.delete(cb);
      // Close the shared connection only when the very last subscriber leaves
      if (subscribers.size === 0) teardown();
    };
  }, []); // empty deps — register once per component lifetime
}
