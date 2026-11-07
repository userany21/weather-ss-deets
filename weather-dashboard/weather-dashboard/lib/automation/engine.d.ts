export interface CitySchedule {
  tz: string;
  cadence: number;
  offset: number;
}

export interface DimSpec {
  id: string;
  arg: string | null;
  n: number | null;
}

export type RuleClass =
  | { kind: "closing"; bucket: number }
  | { kind: "first_tick" }
  | { kind: "never"; reason: string };

export interface TickLite {
  pacing_time: string;
  captured_at: Date | string | number;
  bracket?: string | null;
  yes_price_cents?: number | null;
  yes_price?: number | null;
}

export interface GateArgs {
  cls: RuleClass;
  city: string;
  now: Date | string | number;
  ticks: TickLite[];
  maxSignalAgeMin?: number;
  closeGraceMin?: number;
  firstTickGraceMin?: number;
}

export type GateResult =
  | { state: "unknown_city"; localDate: null }
  | { state: "never" | "not_yet" | "expired" | "missing"; localDate: string }
  | { state: "stale"; localDate: string; label: string; ageMin: number }
  | { state: "ready"; localDate: string; label: string; capturedAt: number; ageMin: number };

export interface PlannedBuy {
  bracket: string;
  method: string | null;
  intentId: string;
  signalPriceCents: number | null;
}

export interface BuyPlan {
  buys: PlannedBuy[];
  reason?: "no_match" | "too_broad";
  count: number;
}

export const CITY_SCHEDULE: Readonly<Record<string, CitySchedule>>;
export const FIRST_TICK_WINDOW: Readonly<Record<string, readonly [number, number]>>;
export const DEFAULT_N: Readonly<Record<string, number>>;
export const KNOWN_DIM_IDS: Set<string>;
export const FIRST_HOUR24: number;
export const LAST_HOUR24: number;

export function cityKey(city: unknown): string;
export function scheduleFor(city: unknown): CitySchedule | null;
export function closingMinute(city: unknown): number | null;
export function ticksInHour(city: unknown): number[];
export function pickClosingTicks<T extends { p: { hour24: number; minute: number }; cap: number }>(
  items: readonly T[],
  hour24: number,
  minMinute: number,
): T[];
export function parsePacingTime(label: unknown): { hour24: number; minute: number } | null;
export function formatLabel(hour24: number, minute: number): string;
export function localParts(date: Date, tz: string): { date: string; hour: number; minute: number };
export function parseBy(by: unknown): DimSpec[];
export function classifyBy(specs: DimSpec[]): RuleClass;
export function gate(args: GateArgs): GateResult;
export function intentIdFor(parts: { ruleId: string; city: string; localDate: string; bracket: string }): string;
export function signalPriceFor(args: { bracket: string; label: string; tickDocs: TickLite[] }): number | null;
export function planBuys(args: {
  ruleId: string;
  city: string;
  localDate: string;
  label: string;
  matches: Array<{ bracket: string; method?: string | null }>;
  tickDocs: TickLite[];
  maxBuys?: number;
}): BuyPlan;
export function outcomeWon(bracket: unknown, winningBracket: unknown): boolean;
export function pnlFor(args: { shares: number; spentUsd: number; won: boolean }): number;
