// Hand-written types for lib/feature-reducer.js (a synced copy of shared/feature-reducer.js).
// Keep in step with the runtime exports; test/reducer-copy-sync.test.js checks the names.

export const FEATURE_VERSION: 2;
export const NUM_HOURS: 10;
export const START_HOUR: 8;
export const END_HOUR: 18;
export const DEFAULT_MAX_STALE_MS: number;
export const METHODS: readonly ["linear", "reciprocal"];
export const ENTRY_SOURCE: {
  readonly TICK_AT_TN: "tick_at_T_N";
  readonly PRICES_ALL: "prices_all_at_T_N";
  readonly LAST_TICK: "last_tick_before_T_N";
  readonly NONE: "none";
};
export const TRUSTED_ENTRY_SOURCES: readonly string[];
export const DEFINITION_HASH: string;
export const HASHED_NAMES: readonly string[];
export const UNHASHED_NAMES: readonly string[];

export type MethodName = "linear" | "reciprocal";
export type CollectionName = MethodName | "high-temp";
export type EntrySource = "tick_at_T_N" | "prices_all_at_T_N" | "last_tick_before_T_N" | "none";
export type RankTrend = "rising" | "falling" | "stable";

export interface Vote {
  id: string;
  collection: MethodName;
  coll: 0 | 1;
  t: number;
  hour: number;
  pacingMinutes: number;
  bracket: string;
  price: number | null;
  pricesAll: Map<string, number> | null;
  city?: string;
  local_date?: string;
}

export interface TickDoc {
  _id?: unknown;
  city?: string;
  local_date?: string;
  pacing_time?: unknown;
  bracket?: unknown;
  yes_price_cents?: unknown;
  captured_at?: unknown;
  prices_all?: Record<string, number> | null;
  [k: string]: unknown;
}

export interface BracketFeatures {
  bracket: string;
  first_tick_price_cents: number | null;
  first_tick_hour: number | null;
  has_price: boolean;
  snapshot_ts: (string | null)[];
  snapshot_seq: (number | null)[];
  snapshot_vote_bracket: (string | null)[];
  tick_count_asof: (number | null)[];
  rank_asof: (number | null)[];
  rank_comp_asof: (number | null)[];
  is_leader_asof: (boolean | null)[];
  lead_margin_asof: (number | null)[];
  total_votes_asof: (number | null)[];
  entry_price_cents: (number | null)[];
  entry_price_source: (EntrySource | null)[];
  entry_price_age_s: (number | null)[];
  rank_trend_asof: (RankTrend | null)[];
  final_tick_count: number;
  final_rank: number;
}

export interface SnapshotSummary {
  hour: number;
  ts: string;
  seq: number;
  vote_bracket: string;
  total_votes: number;
  lead_margin: number;
}

export interface DayResult {
  feature_version: 2;
  definition_hash: string;
  late_votes: number;
  order_violations: number;
  total_votes: number;
  first_vote: {
    bracket: string;
    pacing_minutes: number;
    captured_at: string;
    seq: number;
    price: number | null;
  } | null;
  snapshots: (SnapshotSummary | null)[];
  brackets: BracketFeatures[];
}

export interface ReducerOptions {
  maxStaleMs?: number;
}

export class FeatureReducer {
  constructor(opts?: ReducerOptions);
  readonly maxStaleMs: number;
  readonly seq: number;
  readonly lateVotes: number;
  readonly orderViolations: number;
  push(vote: Vote | null): boolean;
  result(): DayResult;
}

export function computeDefinitionHash(): string;
export function isTrustedSource(source: string | null | undefined): boolean;
export function parsePacing(pt: unknown): { hour24: number; minute: number } | null;
export function pacingBucket(pt: unknown): number | null;
export function toEpochMs(v: unknown): number;
export function normalizeTick(doc: TickDoc | null | undefined, collection: CollectionName): Vote | null;
export function normalizeTickDetailed(
  doc: TickDoc | null | undefined,
  collection: CollectionName
): { vote: Vote | null; reason: string | null };
export function votesFromTicks(docs: TickDoc[], collection: CollectionName): Vote[];
export function compareVotes(a: Vote, b: Vote): number;
export function sortVotes(votes: Vote[]): Vote[];
export function bracketLow(title: string): number;
export function compareBracketRecords(
  a: { count: number; firstSeq: number; low: number; bracket: string },
  b: { count: number; firstSeq: number; low: number; bracket: string }
): number;
export function rankTrend(now: number | null | undefined, prev: number | null | undefined): RankTrend | null;
export function reduceDay(votes: Vote[], opts?: ReducerOptions): DayResult;
