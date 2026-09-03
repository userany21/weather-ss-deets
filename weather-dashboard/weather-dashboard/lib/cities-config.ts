// lib/cities-config.ts
//
// Mirrors the CITIES roster + cadence groups already established in
// weather-ss-deets/screenshot.js. Keep this in sync if the roster changes.

export type Region = "america" | "asia" | "europe";

export interface CityConfig {
  /** Mongo `city` field value, e.g. "los angeles" */
  city: string;
  region: Region;
  /** IANA timezone for computing "is this city currently 8am-6pm local" */
  timezone: string;
  /** How often new ticks land for this city, in minutes (for live polling / labeling only) */
  cadenceMinutes: number;
}

export const CITIES: CityConfig[] = [
  // America — 15 min ticks, :00/:15/:30/:45, window 8am-6pm local
  { city: "san francisco", region: "america", timezone: "America/Los_Angeles", cadenceMinutes: 15 },
  { city: "seattle", region: "america", timezone: "America/Los_Angeles", cadenceMinutes: 15 },
  { city: "los angeles", region: "america", timezone: "America/Los_Angeles", cadenceMinutes: 15 },
  { city: "nyc", region: "america", timezone: "America/New_York", cadenceMinutes: 15 },
  { city: "atlanta", region: "america", timezone: "America/New_York", cadenceMinutes: 15 },
  { city: "miami", region: "america", timezone: "America/New_York", cadenceMinutes: 15 },

  // Asia
  { city: "hong kong", region: "asia", timezone: "Asia/Hong_Kong", cadenceMinutes: 10 },
  { city: "shenzhen", region: "asia", timezone: "Asia/Shanghai", cadenceMinutes: 60 },
  { city: "beijing", region: "asia", timezone: "Asia/Shanghai", cadenceMinutes: 30 },
  { city: "shanghai", region: "asia", timezone: "Asia/Shanghai", cadenceMinutes: 30 },
  { city: "tokyo", region: "asia", timezone: "Asia/Tokyo", cadenceMinutes: 30 },
  { city: "seoul", region: "asia", timezone: "Asia/Seoul", cadenceMinutes: 30 },
  { city: "singapore", region: "asia", timezone: "Asia/Singapore", cadenceMinutes: 30 },

  // Europe
  { city: "london", region: "europe", timezone: "Europe/London", cadenceMinutes: 30 },
  { city: "munich", region: "europe", timezone: "Europe/Berlin", cadenceMinutes: 30 },
  { city: "milan", region: "europe", timezone: "Europe/Rome", cadenceMinutes: 30 },
  { city: "amsterdam", region: "europe", timezone: "Europe/Amsterdam", cadenceMinutes: 30 },
  { city: "madrid", region: "europe", timezone: "Europe/Madrid", cadenceMinutes: 30 },
  { city: "paris", region: "europe", timezone: "Europe/Paris", cadenceMinutes: 30 },
];

export const REGIONS: Region[] = ["america", "asia", "europe"];

export function citiesInRegion(region: string): CityConfig[] {
  return CITIES.filter((c) => c.region === region);
}

export function getCityConfig(city: string): CityConfig | undefined {
  return CITIES.find((c) => c.city === city.toLowerCase());
}

/**
 * Build a CityConfig from Mongo-stored fields (region + timezone come from the
 * document itself for docs written after the sync update). Falls back to the
 * hardcoded CITIES list for older documents that don't carry those fields yet.
 *
 * Returns null only if the city is completely unknown to both Mongo metadata
 * and the static config (should never happen in practice).
 */
export function enrichCity(
  city: string,
  mongoRegion?: string | null,
  mongoTimezone?: string | null,
): CityConfig | null {
  const lower = city.toLowerCase();
  const fallback = getCityConfig(lower);

  if (mongoRegion && mongoTimezone) {
    return {
      city: lower,
      region: mongoRegion as Region,
      timezone: mongoTimezone,
      // cadenceMinutes from static config if available, otherwise a safe default
      cadenceMinutes: fallback?.cadenceMinutes ?? 30,
    };
  }

  return fallback ?? null;
}

/**
 * Is this city currently inside its 8am-6pm local capture window?
 * Returns the current local HH:mm too, since the UI wants to show it.
 */
export function getLiveStatus(cityCfg: CityConfig, now: Date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: cityCfg.timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: cityCfg.timezone }); // en-CA -> YYYY-MM-DD
  const localDate = dateFmt.format(now);

  const isLive = hour >= 8 && hour < 18;

  return {
    localDate,
    localTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    isLive,
  };
}
