// Calculates Stats page numbers for saved Auto-buy rules.
// It calls aggregate(). It does not copy any edge math.
// Server only. Do not import this file in a client component.

import { aggregate } from "@/lib/stats-aggregator";
import type { BucketResult, StatsFilters } from "@/lib/stats-aggregator";
import { parseDimensions } from "@/lib/automation/liveBridge";
import type { RuleRow } from "@/lib/automation/store";

export type RuleBacktest = Pick<
  BucketResult,
  "count" | "raw_count" | "resolved" | "win_rate" | "avg_edge_cents"
>;

export interface RuleBacktestResponse {
  as_of: number | null; // Time of the oldest result, in ms. null if there is no result.
  failed: number; // Number of rules that have no fresh result.
  backtests: Record<string, RuleBacktest | null>; // The key is the rule id.
}

interface CacheEntry {
  value: RuleBacktest | null;
  computedAt: number | null;
  expiresAt: number;
  lastUsedAt: number;
  failed: boolean;
}

const TTL_MS = 60_000; // Keep a good result for 60 seconds.
const RETRY_MS = 10_000; // After an error, try again in 10 seconds.
const PRUNE_MS = 10 * 60_000; // Remove an entry that is not used for 10 minutes.

const cache = new Map<string, CacheEntry>();
let inflight: Promise<void> | null = null; // Only one refresh runs at a time.

function citiesOf(rule: RuleRow): string[] {
  return rule.cities.map((c) => c.toLowerCase()).sort();
}

function ruleSig(rule: RuleRow): string {
  return [rule.criteria_key, rule.by_param, rule.method, citiesOf(rule).join(",")].join("#");
}

function filterSig(rule: RuleRow): string {
  return [rule.method, citiesOf(rule).join(",")].join("#");
}

// Use the same defaults as the Stats page.
// Read app/api/stats/route.ts. Build the same StatsFilters object.
// Use the same value for the method that the Stats page sends.
function buildFilters(rule: RuleRow): StatsFilters {
  const cities = citiesOf(rule);
  return {
    cities: cities.length > 0 ? cities : undefined,
    methods: rule.method === "all" ? undefined : [rule.method],
    resolvedOnly: true,
    dedupe: true,
    minCount: 0, // minCount hides buckets. Do not hide any bucket here.
  };
}

function pickStats(bucket: BucketResult): RuleBacktest {
  return {
    count: bucket.count,
    raw_count: bucket.raw_count,
    resolved: bucket.resolved,
    win_rate: bucket.win_rate,
    avg_edge_cents: bucket.avg_edge_cents,
  };
}

function prune(now: number): void {
  for (const [sig, entry] of cache) {
    if (now - entry.lastUsedAt > PRUNE_MS) cache.delete(sig);
  }
}

async function refresh(rules: RuleRow[]): Promise<void> {
  // Group the rules by filters, then by dimension list.
  // One aggregate() call serves all rules in one group.
  const groups = new Map<string, Map<string, RuleRow[]>>();
  for (const rule of rules) {
    const f = filterSig(rule);
    const byMap = groups.get(f) ?? new Map<string, RuleRow[]>();
    const list = byMap.get(rule.by_param) ?? [];
    list.push(rule);
    byMap.set(rule.by_param, list);
    groups.set(f, byMap);
  }

  // Run one aggregate() call at a time. This keeps memory use low.
  for (const byMap of groups.values()) {
    for (const [byParam, list] of byMap) {
      try {
        const dimensions = parseDimensions(byParam);
        const result = await aggregate(buildFilters(list[0]), dimensions);
        const byKey = new Map(result.buckets.map((b) => [b.key, b]));
        const now = Date.now();
        for (const rule of list) {
          const bucket = byKey.get(rule.criteria_key);
          cache.set(ruleSig(rule), {
            value: bucket ? pickStats(bucket) : null,
            computedAt: now,
            expiresAt: now + TTL_MS,
            lastUsedAt: now,
            failed: false,
          });
        }
      } catch (error) {
        console.error("[ruleBacktest] aggregate failed for", byParam, error);
        const now = Date.now();
        for (const rule of list) {
          const previous = cache.get(ruleSig(rule));
          cache.set(ruleSig(rule), {
            value: previous?.value ?? null, // Keep the old value when there is one.
            computedAt: previous?.computedAt ?? null,
            expiresAt: now + RETRY_MS,
            lastUsedAt: now,
            failed: true,
          });
        }
      }
    }
  }
}

export async function getRuleBacktests(rules: RuleRow[]): Promise<RuleBacktestResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = Date.now();
    const missing = rules.filter((rule) => {
      const entry = cache.get(ruleSig(rule));
      return !entry || entry.expiresAt <= now;
    });
    if (missing.length === 0) break;
    if (!inflight) {
      prune(now);
      inflight = refresh(missing).finally(() => {
        inflight = null;
      });
    }
    await inflight; // A refresh from another request can have a different rule list. The second attempt covers it.
  }

  const now = Date.now();
  const backtests: Record<string, RuleBacktest | null> = {};
  let asOf: number | null = null;
  let failed = 0;
  for (const rule of rules) {
    const entry = cache.get(ruleSig(rule));
    if (entry) entry.lastUsedAt = now;
    backtests[rule.id] = entry?.value ?? null;
    if (!entry || entry.failed) failed += 1;
    if (entry?.computedAt != null) {
      asOf = asOf === null ? entry.computedAt : Math.min(asOf, entry.computedAt);
    }
  }
  return { as_of: asOf, failed, backtests };
}
