"use client";

import { useEffect, useRef } from "react";

export interface TickEvent {
  city: string;
  local_date: string;
  pacing_time: string | null;
}

/**
 * Subscribes to /api/stream for the lifetime of the component and calls
 * onTick for every new insert reported. EventSource reconnects on its own
 * if the connection drops, so no manual retry logic is needed here.
 */
export function useWeatherStream(onTick: (event: TickEvent) => void) {
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    const es = new EventSource("/api/stream");

    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as TickEvent;
        onTickRef.current(data);
      } catch {
        /* heartbeat comments and malformed payloads are ignored */
      }
    };

    return () => es.close();
  }, []);
}
