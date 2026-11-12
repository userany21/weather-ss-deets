import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  DIMENSION_REGISTRY_MAP,
  decisionSlot,
  type DimensionSpec,
} from "@/lib/stats-aggregator";
import { parseScriptRule } from "@/lib/script-rule";
import * as engine from "@/lib/automation/engine";

// engine.js is plain CommonJS. This test reads it without types.
// The runner may place those exports on the module or on its default.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loaded = engine as any;
const eng = typeof loaded.classifyBy === "function" ? loaded : loaded.default;

function goldenRules(): string[] {
  const file = path.join(process.cwd(), "test/golden/dump_index.txt");
  const rules = fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]);
  return Array.from(new Set(rules));
}

// Rules that cover every hour dimension and the first-tick case.
const EXTRA_RULES = [
  "leader:1=Yes",
  "leader:9=No",
  "rank_at_hour:9=1",
  "lead_margin:1=moderate",
  "rank_trend:4=rising",
  "price_at_hour:0=40-59c",
  "price_at_hour:9=40-59c",
  "first_tick_hour=8AM",
  "city=tokyo",
];

test("decision slot: engine.classifyBy equals decisionSlot", () => {
  for (const rule of Array.from(new Set([...goldenRules(), ...EXTRA_RULES]))) {
    const { by, dimensions } = parseScriptRule(rule);
    const cls = eng.classifyBy(eng.parseBy(by));
    const d = decisionSlot(dimensions);
    if (cls.kind === "closing") {
      assert.deepEqual({ rule, d }, { rule, d: { kind: "slot", slot: cls.bucket } });
    } else if (cls.kind === "first_tick") {
      assert.deepEqual({ rule, d }, { rule, d: { kind: "first_tick" } });
    } else {
      assert.deepEqual({ rule, kind: d.kind }, { rule, kind: "none" });
    }
  }
});

test("end-of-day filter: engine says never, decisionSlot says none", () => {
  for (const id of ["final_rank", "final_tick_count"]) {
    const dims: DimensionSpec[] = [{ id, config: {} }];
    assert.equal(eng.classifyBy(eng.parseBy(id)).kind, "never");
    assert.equal(decisionSlot(dims).kind, "none");
  }
});

test("engine DEFAULT_N equals the registry defaults", () => {
  for (const [id, n] of Object.entries(eng.DEFAULT_N)) {
    const def = DIMENSION_REGISTRY_MAP.get(id)?.configSchema?.default;
    assert.deepEqual({ id, def }, { id, def: n });
  }
});
