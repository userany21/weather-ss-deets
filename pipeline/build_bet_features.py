#!/usr/bin/env python3
"""
Build bet_features from high-temp and reciprocal.

Stage 1 rebuilds the legacy through-hour arrays (live-features.ts) and diffs them
against stats_features_legacy_20261102. Stage 2 writes one document per bet. Methods are linear, reciprocal, and combined.
combined is both collections as one stream, ordered the way feature-reducer.js
orders votes: (captured_at, collection rank linear=0/reciprocal=1, _id). Counts
sum. The gate is replayed on that merged stream. build-feature-table.js does not
write combined (one scrape has no shared id); this file still builds that stream,
because the order above is the rule those files give for mixing the two collections.

Hour buckets are taken at the tick worker.ts would actually buy.

Worker tick choice (differs from "earliest minute >= close"):
  worker.ts calls engine.gate, which calls pickClosingTicks. That keeps the
  HIGHEST pacing minute at or after the nominal close among ticks already stored,
  not the earliest minute. The worker buys on the first pass whose state is
  "ready", records that city-day, and does not consider a later minute. A "stale"
  pass is also final. This replay evaluates 60 seconds after each tick's
  captured_at and uses only ticks stored by then. The real cron also fires once a
  minute across the grace window; a closing tick captured more than 60 seconds
  before the nominal close is not re-checked when the window opens.

Hours with no ready closing tick stay null. The stage 1 and stage 2 checks skip
those hours and print how many were skipped.

Nothing here writes to stats_features, stats_features_legacy_20261102, high-temp,
or reciprocal. The only write target is bet_features, and only with --apply.
"""
from __future__ import annotations

import argparse
import math
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from pymongo import MongoClient, ReplaceOne

OUT_COLLECTION = "bet_features"
LEGACY_COLLECTION = "stats_features_legacy_20261102"
PROTECTED = {"stats_features", "stats_features_legacy_20261102", "high-temp", "reciprocal"}
LEGACY_CUTOFF = "2026-11-02"
NUM_HOURS = 10
START_HOUR = 8
CLOSE_GRACE_MIN = 20
MAX_SIGNAL_AGE_MIN = 12
EVAL_LAG_MS = 60_000
BATCH = 500

CITY_SCHEDULE = {
    "san francisco": {"tz": "America/Los_Angeles", "cadence": 15, "offset": 0},
    "seattle": {"tz": "America/Los_Angeles", "cadence": 15, "offset": 0},
    "los angeles": {"tz": "America/Los_Angeles", "cadence": 15, "offset": 0},
    "nyc": {"tz": "America/New_York", "cadence": 15, "offset": 0},
    "atlanta": {"tz": "America/New_York", "cadence": 15, "offset": 0},
    "miami": {"tz": "America/New_York", "cadence": 15, "offset": 0},
    "hong kong": {"tz": "Asia/Hong_Kong", "cadence": 10, "offset": 0},
    "shenzhen": {"tz": "Asia/Shanghai", "cadence": 60, "offset": 0},
    "beijing": {"tz": "Asia/Shanghai", "cadence": 30, "offset": 0},
    "shanghai": {"tz": "Asia/Shanghai", "cadence": 30, "offset": 0},
    "tokyo": {"tz": "Asia/Tokyo", "cadence": 30, "offset": 0},
    "seoul": {"tz": "Asia/Seoul", "cadence": 30, "offset": 0},
    "singapore": {"tz": "Asia/Singapore", "cadence": 30, "offset": 0},
    "london": {"tz": "Europe/London", "cadence": 30, "offset": 20},
    "munich": {"tz": "Europe/Berlin", "cadence": 30, "offset": 20},
    "milan": {"tz": "Europe/Rome", "cadence": 30, "offset": 20},
    "amsterdam": {"tz": "Europe/Amsterdam", "cadence": 30, "offset": 25},
    "madrid": {"tz": "Europe/Madrid", "cadence": 30, "offset": 0},
    "paris": {"tz": "Europe/Paris", "cadence": 30, "offset": 0},
}

FIRST_TICK_WINDOW = {
    "tokyo": (510, 510),
    "shenzhen": (540, 540),
    "seoul": (510, 510),
    "beijing": (510, 510),
    "shanghai": (510, 510),
    "hong kong": (490, 490),
    "singapore": (510, 510),
    "london": (500, 500),
    "munich": (500, 500),
    "milan": (500, 500),
    "amsterdam": (505, 505),
    "madrid": (510, 510),
    "paris": (510, 510),
    "san francisco": (495, 505),
    "seattle": (495, 505),
    "los angeles": (495, 505),
    "nyc": (495, 505),
    "atlanta": (495, 505),
    "miami": (495, 505),
}

TICK_SOURCES = (
    ("high-temp", "linear"),
    ("reciprocal", "reciprocal"),
)

_PACING_LIVE = re.compile(r"^(\d{1,2}):(\d{2})\s*(AM|PM)$", re.I)
_PACING_ENGINE = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?\s*$")
_BELOW = re.compile(r"or\s+below", re.I)
_RANGE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)")
_NUM = re.compile(r"-?\d+(?:\.\d+)?")
_ZONES = {name: ZoneInfo(cfg["tz"]) for name, cfg in CITY_SCHEDULE.items()}


def closing_minute(city: str):
    cfg = CITY_SCHEDULE.get(city)
    if not cfg:
        return None
    return cfg["offset"] + ((59 - cfg["offset"]) // cfg["cadence"]) * cfg["cadence"]


def epoch_ms(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(round(value.timestamp() * 1000))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def iso_from_ms(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def local_clock(ms: int, city: str):
    dt = datetime.fromtimestamp(ms / 1000, _ZONES[city])
    return dt.strftime("%Y-%m-%d"), dt.hour, dt.minute


def parse_pacing_live(pt):
    """live-features.ts pacingTimeToBucket. Minute is not range-checked."""
    if not isinstance(pt, str):
        return None
    m = _PACING_LIVE.match(pt.strip())
    if not m:
        return None
    hour = int(m.group(1))
    minute = int(m.group(2))
    meridiem = m.group(3).upper()
    if meridiem == "PM" and hour != 12:
        hour += 12
    if meridiem == "AM" and hour == 12:
        hour = 0
    if hour < 8 or hour >= 18:
        return None
    return hour - 8, hour, minute


def parse_pacing_engine(pt):
    """engine.js parsePacingTime. Rejects minute > 59."""
    if pt is None:
        return None
    m = _PACING_ENGINE.match(str(pt))
    if not m:
        return None
    hour = int(m.group(1))
    minute = int(m.group(2))
    if hour < 1 or hour > 12 or minute > 59:
        return None
    pm = m.group(3).lower() == "p"
    hour24 = (hour % 12) + (12 if pm else 0)
    return hour24, minute


def is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def js_round_2(cents: float) -> float:
    return math.floor(cents * 100 + 0.5) / 100


def signal_price(cents, yes_price):
    """engine.js signalPriceFor, one tick."""
    if is_number(cents):
        value = float(cents)
    elif is_number(yes_price):
        value = float(yes_price) * 100
    else:
        return None
    if not (value > 0 and value < 100):
        return None
    return js_round_2(value)


def bracket_low(title: str) -> float:
    if _BELOW.search(title):
        return float("-inf")
    rng = _RANGE.match(title)
    if rng:
        return float(rng.group(1))
    num = _NUM.search(title)
    return float(num.group(0)) if num else float("inf")


def low_key(low: float):
    if low == float("-inf"):
        return (0, 0.0)
    if low == float("inf"):
        return (2, 0.0)
    return (1, low)


def norm_bracket(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def cap_str(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return "" if value is None else str(value)


# --------------------------------------------------------------------------------------
# Load
# --------------------------------------------------------------------------------------

def load_raw(db, city, since=None):
    proj = {
        "city": 1, "local_date": 1, "bracket": 1, "pacing_time": 1,
        "captured_at": 1, "yes_price": 1, "yes_price_cents": 1, "winning_bracket": 1,
    }
    out = []
    for collection, method in TICK_SOURCES:
        query = {}
        if city:
            query["city"] = city
        if since:
            query["local_date"] = {"$gte": since}
        n = 0
        for doc in db[collection].find(query, proj, batch_size=5000):
            n += 1
            out.append({
                "collection": collection,
                "method": method,
                "city": doc.get("city"),
                "local_date": str(doc.get("local_date") or ""),
                "bracket_raw": doc.get("bracket"),
                "bracket": norm_bracket(doc.get("bracket")),
                "pacing": doc.get("pacing_time"),
                "captured_at": cap_str(doc.get("captured_at")),
                "epoch": epoch_ms(doc.get("captured_at")),
                "id": str(doc["_id"]),
                "cents": doc.get("yes_price_cents") if is_number(doc.get("yes_price_cents")) else None,
                "yes_price": doc.get("yes_price") if is_number(doc.get("yes_price")) else None,
                "winning_bracket": doc.get("winning_bracket"),
            })
        print(f"  read {collection}: {n:,} docs")
    return out


def collect_winners(raw):
    """build-feature-table.js fetchWinners: high-temp first, then reciprocal."""
    winners = {}
    warnings = []
    for collection, _method in TICK_SOURCES:
        rows = [r for r in raw if r["collection"] == collection and norm_bracket(r["winning_bracket"])]
        rows.sort(key=lambda r: (r["captured_at"], r["id"]))
        seen = {}
        all_values = defaultdict(set)
        for r in rows:
            if not r["city"] or not r["local_date"]:
                continue
            key = (r["city"], r["local_date"])
            w = norm_bracket(r["winning_bracket"])
            all_values[key].add(w)
            if key not in seen:
                seen[key] = w
        for key, values in all_values.items():
            if len(values) > 1:
                warnings.append(
                    f"WARNING {collection} {key[0]}|{key[1]}: more than one winning_bracket: "
                    + " | ".join(sorted(values))
                )
        for key, w in seen.items():
            if key in winners and winners[key] != w:
                warnings.append(
                    f"WARNING {key[0]}|{key[1]}: winner differs between collections "
                    f"({winners[key]} vs {w} in {collection}); keeping the first"
                )
                continue
            if key not in winners:
                winners[key] = w
    return winners, warnings


# --------------------------------------------------------------------------------------
# Stage 1: live-features.ts through-hour arrays
# --------------------------------------------------------------------------------------

def _empty_accum():
    return {"ticks": [0] * NUM_HOURS, "price": [None] * NUM_HOURS, "cap": [None] * NUM_HOURS}


def build_bracket_map(docs):
    """One collection, already sorted by (captured_at, _id). Includes out-of-window brackets."""
    data = {}
    for doc in docs:
        raw_b = doc["bracket_raw"]
        if raw_b is None or raw_b == "":
            continue
        bracket = raw_b if isinstance(raw_b, str) else str(raw_b)
        if not bracket:
            continue
        key = (doc["city"], doc["local_date"])
        brs = data.get(key)
        if brs is None:
            brs = {}
            data[key] = brs
        acc = brs.get(bracket)
        if acc is None:
            acc = _empty_accum()
            brs[bracket] = acc
        parsed = parse_pacing_live(doc["pacing"]) if isinstance(doc["pacing"], str) else None
        if parsed is None:
            continue
        bucket = parsed[0]
        acc["ticks"][bucket] += 1
        if doc["cents"] is not None:
            ca = doc["captured_at"]
            prev = acc["cap"][bucket]
            if prev is None or ca < prev:
                acc["cap"][bucket] = ca
                acc["price"][bucket] = doc["cents"]
    return data


def merge_bracket_maps(map_a, map_b):
    merged = {}
    for key, brs_a in map_a.items():
        brs = {}
        for bracket, acc in brs_a.items():
            brs[bracket] = {
                "ticks": acc["ticks"][:],
                "price": acc["price"][:],
                "cap": acc["cap"][:],
            }
        merged[key] = brs
    for key, brs_b in map_b.items():
        brs = merged.get(key)
        if brs is None:
            brs = {}
            for bracket, acc in brs_b.items():
                brs[bracket] = {
                    "ticks": acc["ticks"][:],
                    "price": acc["price"][:],
                    "cap": acc["cap"][:],
                }
            merged[key] = brs
            continue
        for bracket, acc_b in brs_b.items():
            acc = brs.get(bracket)
            if acc is None:
                brs[bracket] = {
                    "ticks": acc_b["ticks"][:],
                    "price": acc_b["price"][:],
                    "cap": acc_b["cap"][:],
                }
                continue
            for i in range(NUM_HOURS):
                acc["ticks"][i] += acc_b["ticks"][i]
                cap_b = acc_b["cap"][i]
                if cap_b is not None and (acc["cap"][i] is None or cap_b < acc["cap"][i]):
                    acc["cap"][i] = cap_b
                    acc["price"][i] = acc_b["price"][i]
    return merged


def through_hour_rows(bracket_map, method):
    rows = {}
    for (city, local_date), brackets in bracket_map.items():
        items = list(brackets.items())
        cum = {}
        for bracket, acc in items:
            running = 0
            totals = []
            for n in range(NUM_HOURS):
                running += acc["ticks"][n]
                totals.append(running)
            cum[bracket] = totals
        order_at = []
        lead = []
        for n in range(NUM_HOURS):
            ordered = sorted(((b, cum[b][n]) for b, _ in items), key=lambda pair: -pair[1])
            order_at.append(ordered)
            total = 0
            for _, count in ordered:
                total += count
            if total == 0:
                lead.append(0)
            else:
                top1 = ordered[0][1]
                top2 = ordered[1][1] if len(ordered) > 1 else 0
                lead.append((top1 - top2) / total)
        for bracket, acc in items:
            ranks = []
            leaders = []
            for n in range(NUM_HOURS):
                ordered = order_at[n]
                rank = 1
                for name, _count in ordered:
                    if name == bracket:
                        ranks.append(rank)
                        break
                    rank += 1
                my = cum[bracket][n]
                max_count = ordered[0][1] if ordered else 0
                leaders.append(bool(my > 0 and my == max_count))
            rows[(city, local_date, method, bracket)] = {
                "tick_count_through_hour": cum[bracket],
                "rank_through_hour": ranks,
                "is_leader_through_hour": leaders,
                "lead_margin_through_hour": lead,
                "price_at_hour": acc["price"][:],
            }
    return rows


def build_legacy(raw):
    by_method = {method: [] for _c, method in TICK_SOURCES}
    for doc in raw:
        by_method[doc["method"]].append(doc)
    for method in by_method:
        by_method[method].sort(key=lambda d: (d["captured_at"], d["id"]))
    linear = build_bracket_map(by_method["linear"])
    reciprocal = build_bracket_map(by_method["reciprocal"])
    combined = merge_bracket_maps(linear, reciprocal)
    rows = {}
    rows.update(through_hour_rows(linear, "linear"))
    rows.update(through_hour_rows(reciprocal, "reciprocal"))
    rows.update(through_hour_rows(combined, "combined"))
    return rows


def values_equal(ours, legacy):
    if isinstance(ours, bool) or isinstance(legacy, bool):
        return bool(ours) is bool(legacy) if isinstance(ours, bool) and isinstance(legacy, bool) else False
    if ours is None and legacy is None:
        return True
    if ours is None or legacy is None:
        return False
    if is_number(ours) and is_number(legacy):
        return abs(float(ours) - float(legacy)) <= 1e-9
    return ours == legacy


# --------------------------------------------------------------------------------------
# Gate replay (worker.ts + engine.js)
# --------------------------------------------------------------------------------------

def _pick_closing(visible, hour24, min_minute):
    kept = [t for t in visible if t["hour24"] == hour24 and t["minute"] >= min_minute]
    if not kept:
        return None
    highest = kept[0]["minute"]
    for t in kept:
        if t["minute"] > highest:
            highest = t["minute"]
    selected = [t for t in kept if t["minute"] == highest]
    captured = selected[0]["epoch"]
    for t in selected:
        if t["epoch"] > captured:
            captured = t["epoch"]
    return highest, captured


def replay_closing(gate_ticks, city, local_date):
    """Per hour, the signal the worker would act on, or None."""
    if city not in CITY_SCHEDULE:
        return [None] * NUM_HOURS
    close_m = closing_minute(city)
    ticks = [t for t in gate_ticks if t["epoch"] is not None]
    ticks.sort(key=lambda t: (t["epoch"], t.get("coll", 0), t["id"]))
    by_hour = defaultdict(list)
    for t in ticks:
        by_hour[t["hour24"]].append(t)
    signals = [None] * NUM_HOURS
    for bucket in range(NUM_HOURS):
        hour24 = bucket + START_HOUR
        start = hour24 * 60 + close_m
        end = start + CLOSE_GRACE_MIN
        hour_ticks = by_hour.get(hour24, [])
        decided = False
        for t in ticks:
            now = t["epoch"] + EVAL_LAG_MS
            date_s, hour, minute = local_clock(now, city)
            if date_s < local_date:
                continue
            if date_s > local_date:
                break
            now_min = hour * 60 + minute
            if now_min < start:
                continue
            if now_min > end:
                break
            visible = [x for x in hour_ticks if x["epoch"] <= now]
            picked = _pick_closing(visible, hour24, close_m)
            if picked is None:
                continue
            highest, captured = picked
            age = max(0.0, (now - captured) / 60_000)
            if age > MAX_SIGNAL_AGE_MIN:
                signals[bucket] = None
                decided = True
                break
            signals[bucket] = {"minute": highest, "hour24": hour24, "epoch": captured, "gate_open": True}
            decided = True
            break
        if not decided:
            signals[bucket] = None
    return signals


def replay_first_tick(gate_ticks, city, local_date) -> bool:
    window = FIRST_TICK_WINDOW.get(city)
    if window is None or city not in CITY_SCHEDULE:
        return False
    start, end_label = window
    grace_end = start + (end_label - start + CLOSE_GRACE_MIN)
    ticks = [t for t in gate_ticks if t["epoch"] is not None]
    ticks.sort(key=lambda t: (t["epoch"], t.get("coll", 0), t["id"]))
    for t in ticks:
        now = t["epoch"] + EVAL_LAG_MS
        date_s, hour, minute = local_clock(now, city)
        if date_s < local_date:
            continue
        if date_s > local_date:
            break
        now_min = hour * 60 + minute
        if now_min < start:
            continue
        if now_min > grace_end:
            break
        visible = [x for x in ticks if x["epoch"] <= now and start <= x["hour24"] * 60 + x["minute"] <= end_label]
        if not visible:
            continue
        earliest = visible[0]["hour24"] * 60 + visible[0]["minute"]
        for x in visible:
            key = x["hour24"] * 60 + x["minute"]
            if key < earliest:
                earliest = key
        selected = [x for x in visible if x["hour24"] * 60 + x["minute"] == earliest]
        captured = max(x["epoch"] for x in selected)
        age = max(0.0, (now - captured) / 60_000)
        if age > MAX_SIGNAL_AGE_MIN:
            return False
        return True
    return False


def index_gate_ticks(raw):
    grouped = defaultdict(list)
    for doc in raw:
        parsed = parse_pacing_engine(doc["pacing"])
        if parsed is None or doc["epoch"] is None:
            continue
        hour24, minute = parsed
        if hour24 < 8 or hour24 > 17:
            continue
        if not doc["city"] or not doc["local_date"]:
            continue
        grouped[(doc["city"], doc["local_date"], doc["method"])].append({
            "epoch": doc["epoch"],
            "id": doc["id"],
            "coll": 0 if doc["method"] == "linear" else 1,
            "hour24": hour24,
            "minute": minute,
            "bracket": doc["bracket"],
            "cents": doc["cents"],
            "yes_price": doc["yes_price"],
        })
    return grouped


def attach_combined(groups):
    """One stream per city-day: linear votes then reciprocal, feature-reducer order."""
    days = set()
    for city, local_date, method in groups:
        if method in ("linear", "reciprocal"):
            days.add((city, local_date))
    for city, local_date in days:
        merged = []
        for method in ("linear", "reciprocal"):
            merged.extend(groups.get((city, local_date, method), ()))
        if not merged:
            continue
        merged.sort(key=lambda v: (v["epoch"], v.get("coll", 0), v["id"]))
        groups[(city, local_date, "combined")] = merged
    return groups


def compute_signals(gate_groups):
    signals = {}
    first_gate = {}
    for key, ticks in gate_groups.items():
        city, local_date, _method = key
        signals[key] = replay_closing(ticks, city, local_date)
        first_gate[key] = replay_first_tick(ticks, city, local_date)
    return signals, first_gate


# --------------------------------------------------------------------------------------
# Stage 1 report
# --------------------------------------------------------------------------------------

LEGACY_FIELDS = (
    "tick_count_through_hour",
    "rank_through_hour",
    "is_leader_through_hour",
    "lead_margin_through_hour",
    "price_at_hour",
)


def signal_hours_for(signals, city, local_date, method):
    """Hours the check should compare. Combined ignores an hour only when both sources lack one."""
    if method != "combined":
        sig = signals.get((city, local_date, method))
        if sig is None:
            return [True] * NUM_HOURS
        return [s is not None for s in sig]
    linear = signals.get((city, local_date, "linear"))
    reciprocal = signals.get((city, local_date, "reciprocal"))
    keep = []
    for n in range(NUM_HOURS):
        has = (linear is not None and linear[n] is not None) or (
            reciprocal is not None and reciprocal[n] is not None
        )
        # No signal computed at all (city not in the raw pull): compare the hour.
        if linear is None and reciprocal is None:
            has = True
        keep.append(has)
    return keep


def run_parity(db, legacy_rows, signals, city):
    query = {"local_date": {"$lte": LEGACY_CUTOFF}}
    if city:
        query["city"] = city
    proj = {"_id": 0, "city": 1, "local_date": 1, "method": 1, "bracket": 1, **{f: 1 for f in LEGACY_FIELDS}}
    print(f"\nStage 1: diff through-hour arrays against {LEGACY_COLLECTION} through {LEGACY_CUTOFF}")
    legacy_docs = list(db[LEGACY_COLLECTION].find(query, proj, batch_size=5000))
    print(f"  legacy docs: {len(legacy_docs):,}")

    field_bad = {f: 0 for f in LEGACY_FIELDS}
    field_examples = {f: [] for f in LEGACY_FIELDS}
    city_bad = defaultdict(int)
    city_examples = defaultdict(list)
    ignored_slots = 0
    missing = 0
    compared_docs = 0

    for doc in legacy_docs:
        key = (doc.get("city"), str(doc.get("local_date")), doc.get("method"), doc.get("bracket"))
        ours = legacy_rows.get(key)
        keep = signal_hours_for(signals, key[0], key[1], key[2])
        ignored_slots += sum(1 for h in keep if not h)
        if ours is None:
            missing += 1
        compared_docs += 1
        doc_failed = False
        for field in LEGACY_FIELDS:
            leg = doc.get(field) or []
            got = None if ours is None else ours[field]
            bad = ours is None
            detail = "missing rebuilt doc"
            if ours is not None:
                for h in range(NUM_HOURS):
                    if not keep[h]:
                        continue
                    lv = leg[h] if h < len(leg) else None
                    gv = got[h] if h < len(got) else None
                    if not values_equal(gv, lv):
                        bad = True
                        detail = f"hour {h}: rebuilt {gv!r} legacy {lv!r}"
                        break
            if bad:
                field_bad[field] += 1
                doc_failed = True
                if len(field_examples[field]) < 5:
                    field_examples[field].append(f"{key[0]} {key[1]} {key[2]} {key[3]} | {detail}")
        if doc_failed:
            city_bad[key[0]] += 1
            if len(city_examples[key[0]]) < 5:
                city_examples[key[0]].append(f"{key[1]} {key[2]} {key[3]}")

    n = len(legacy_docs)
    print(f"  hour-slots ignored (no closing tick): {ignored_slots:,}")
    print(f"  legacy docs with no rebuilt row: {missing:,}")
    print("\n  mismatches by field (docs, percent of legacy docs):")
    worst = 0.0
    for field in LEGACY_FIELDS:
        rate = (field_bad[field] / n) if n else 0.0
        worst = max(worst, rate)
        print(f"    {field:28} {field_bad[field]:6,}  {rate * 100:6.2f}%")
        for line in field_examples[field]:
            print(f"      e.g. {line}")
    print("\n  mismatches by city (docs failing any compared field):")
    for name, count in sorted(city_bad.items(), key=lambda kv: -kv[1]):
        rate = count / n if n else 0.0
        print(f"    {name:16} {count:6,}  {rate * 100:6.2f}%")
        for line in city_examples[name]:
            print(f"      e.g. {line}")
    if n == 0:
        print("  no legacy docs in range")
        return True
    if worst > 0.01:
        print(
            f"\nSTOP: a field mismatches on more than 1% of docs "
            f"(worst {worst * 100:.2f}%). Stage 2 was not started."
        )
        return False
    print(f"\nStage 1 passed (worst field {worst * 100:.2f}% of {n:,} docs, {compared_docs:,} compared).")
    return True


# --------------------------------------------------------------------------------------
# Stage 2
# --------------------------------------------------------------------------------------

def votes_by_day(raw):
    grouped = defaultdict(list)
    for doc in raw:
        if not doc["bracket"] or not doc["city"] or not doc["local_date"]:
            continue
        parsed = parse_pacing_engine(doc["pacing"])
        if parsed is None or doc["epoch"] is None or not doc["id"]:
            continue
        hour24, minute = parsed
        if hour24 < 8 or hour24 >= 18:
            continue
        grouped[(doc["city"], doc["local_date"], doc["method"])].append({
            "epoch": doc["epoch"],
            "id": doc["id"],
            "coll": 0 if doc["method"] == "linear" else 1,
            "hour": hour24 - 8,
            "minute": minute,
            "bracket": doc["bracket"],
            "cents": doc["cents"],
            "yes_price": doc["yes_price"],
            "captured_at": doc["captured_at"],
        })
    for key in grouped:
        grouped[key].sort(key=lambda v: (v["epoch"], v["coll"], v["id"]))
    return grouped


def reduce_outcomes(votes):
    """feature-reducer.js fields that do not depend on snapshots."""
    seen = set()
    seq = 0
    recs = {}
    order = []
    for vote in votes:
        key = f"{vote['coll']}:{vote['id']}"
        if key in seen:
            continue
        seen.add(key)
        seq += 1
        rec = recs.get(vote["bracket"])
        if rec is None:
            rec = {
                "bracket": vote["bracket"],
                "low": bracket_low(vote["bracket"]),
                "count": 0,
                "first_seq": seq,
                "first_price": vote["cents"],
                "first_hour": vote["hour"],
            }
            recs[vote["bracket"]] = rec
            order.append(vote["bracket"])
        rec["count"] += 1
    ranked = sorted(recs.values(), key=lambda r: (-r["count"], r["first_seq"], low_key(r["low"]), r["bracket"]))
    final_rank = {r["bracket"]: i + 1 for i, r in enumerate(ranked)}
    return recs, order, final_rank


def state_asof(order, votes, cutoff_epoch, max_hour, max_minute):
    """live-features ranking on a prefix of the day. order is the full-day insertion order."""
    counts = {b: 0 for b in order}
    for vote in votes:
        if vote["epoch"] > cutoff_epoch:
            continue
        if vote["hour"] > max_hour:
            continue
        if vote["hour"] == max_hour and vote["minute"] > max_minute:
            continue
        if vote["bracket"] in counts:
            counts[vote["bracket"]] += 1
    ordered = sorted(((b, counts[b]) for b in order), key=lambda pair: -pair[1])
    total = 0
    for _, count in ordered:
        total += count
    if total == 0:
        lead = 0.0
    else:
        top1 = ordered[0][1]
        top2 = ordered[1][1] if len(ordered) > 1 else 0
        lead = (top1 - top2) / total
    max_count = ordered[0][1] if ordered else 0
    rank = {}
    leader = {}
    pos = 1
    for bracket, count in ordered:
        rank[bracket] = pos
        leader[bracket] = bool(count > 0 and count == max_count)
        pos += 1
    return counts, rank, leader, lead


def through_hour_ranks(order, votes):
    """Cumulative through the end of each hour, same votes and insertion order."""
    out = []
    for n in range(NUM_HOURS):
        out.append(state_asof(order, votes, cutoff_epoch=10**18, max_hour=n, max_minute=59))
    return out


def hour_first_price(votes, bracket, bucket, cutoff_epoch, max_minute):
    best_cap = None
    best = None
    for vote in votes:
        if vote["bracket"] != bracket or vote["hour"] != bucket:
            continue
        if vote["epoch"] > cutoff_epoch or vote["minute"] > max_minute:
            continue
        if vote["cents"] is None:
            continue
        if best_cap is None or vote["captured_at"] < best_cap:
            best_cap = vote["captured_at"]
            best = vote["cents"]
    return best


def close_price_for(votes, bracket, bucket, minute):
    """engine.js signalPriceFor: first tick at that label with a usable price."""
    for vote in votes:
        if vote["bracket"] != bracket or vote["hour"] != bucket or vote["minute"] != minute:
            continue
        price = signal_price(vote["cents"], vote["yes_price"])
        if price is not None:
            return price
    return None


def rank_trend(now, prev):
    if now is None or prev is None:
        return None
    if now < prev:
        return "rising"
    if now > prev:
        return "falling"
    return "stable"


def build_bet_docs(vote_groups, signals, first_gate, winners):
    docs = []
    seoul_compared = 0
    seoul_rank_mismatch = 0
    seoul_ignored = 0
    seoul_examples = []
    unknown_cities = set()
    for key, votes in vote_groups.items():
        city, local_date, method = key
        if city not in CITY_SCHEDULE:
            unknown_cities.add(city)
        recs, order, final_rank = reduce_outcomes(votes)
        if not order:
            continue
        sig = signals.get(key) or [None] * NUM_HOURS
        through = through_hour_ranks(order, votes) if city == "seoul" else None
        winner = winners.get((city, local_date))
        resolved = winner is not None
        per_bracket = {b: _blank_hours() for b in order}
        for bucket, signal in enumerate(sig):
            if signal is None:
                if city == "seoul":
                    seoul_ignored += 1
                continue
            counts, rank, leader, lead = state_asof(
                order, votes, signal["epoch"], bucket, signal["minute"]
            )
            if city == "seoul":
                t_counts, t_rank, _, _ = through[bucket]
                for bracket in order:
                    seoul_compared += 1
                    if rank[bracket] != t_rank[bracket]:
                        seoul_rank_mismatch += 1
                        if len(seoul_examples) < 5:
                            seoul_examples.append(
                                f"{local_date} {method} {bracket} hour {bucket}: "
                                f"close rank {rank[bracket]} through {t_rank[bracket]} "
                                f"(counts {counts[bracket]} vs {t_counts[bracket]})"
                            )
            close_ts = iso_from_ms(signal["epoch"])
            for bracket in order:
                slot = per_bracket[bracket]
                slot["close_ts"][bucket] = close_ts
                slot["close_price_cents"][bucket] = close_price_for(votes, bracket, bucket, signal["minute"])
                slot["hour_first_price_cents"][bucket] = hour_first_price(
                    votes, bracket, bucket, signal["epoch"], signal["minute"]
                )
                slot["rank"][bucket] = rank[bracket]
                slot["is_leader"][bucket] = leader[bracket]
                slot["lead_margin"][bucket] = lead
                slot["tick_count"][bucket] = counts[bracket]
                slot["gate_open"][bucket] = True
        for bracket in order:
            slot = per_bracket[bracket]
            for n in range(2, NUM_HOURS):
                slot["rank_trend"][n] = rank_trend(slot["rank"][n], slot["rank"][n - 2])
            rec = recs[bracket]
            docs.append({
                "city": city,
                "local_date": local_date,
                "method": method,
                "bracket": bracket,
                "first_tick_price_cents": rec["first_price"],
                "first_tick_hour": rec["first_hour"],
                "has_price": rec["first_price"] is not None,
                "final_tick_count": rec["count"],
                "final_rank": final_rank[bracket],
                "resolved": resolved,
                "won": (bracket == winner) if resolved else None,
                "first_tick_gate_open": bool(first_gate.get(key, False)),
                "close_ts": slot["close_ts"],
                "close_price_cents": slot["close_price_cents"],
                "hour_first_price_cents": slot["hour_first_price_cents"],
                "rank": slot["rank"],
                "is_leader": slot["is_leader"],
                "lead_margin": slot["lead_margin"],
                "rank_trend": slot["rank_trend"],
                "tick_count": slot["tick_count"],
                "gate_open": slot["gate_open"],
            })
    return docs, {
        "unknown_cities": sorted(unknown_cities),
        "seoul_compared": seoul_compared,
        "seoul_rank_mismatch": seoul_rank_mismatch,
        "seoul_ignored": seoul_ignored,
        "seoul_examples": seoul_examples,
    }


def _blank_hours():
    return {
        "close_ts": [None] * NUM_HOURS,
        "close_price_cents": [None] * NUM_HOURS,
        "hour_first_price_cents": [None] * NUM_HOURS,
        "rank": [None] * NUM_HOURS,
        "is_leader": [None] * NUM_HOURS,
        "lead_margin": [None] * NUM_HOURS,
        "rank_trend": [None] * NUM_HOURS,
        "tick_count": [None] * NUM_HOURS,
        "gate_open": [None] * NUM_HOURS,
    }


def summarize_docs(docs, report):
    print(f"\nStage 2: {len(docs):,} bet documents")
    by_method = defaultdict(int)
    by_city = defaultdict(int)
    resolved = 0
    open_buckets = 0
    for doc in docs:
        by_method[doc["method"]] += 1
        by_city[doc["city"]] += 1
        if doc["resolved"]:
            resolved += 1
        open_buckets += sum(1 for g in doc["gate_open"] if g)
    print(f"  resolved: {resolved:,}")
    print("  by method: " + ", ".join(f"{k}={v:,}" for k, v in sorted(by_method.items())))
    print("  by city:")
    for name, count in sorted(by_city.items(), key=lambda kv: -kv[1]):
        print(f"    {name:16} {count:,}")
    print(f"  ready hour-buckets stored (across bets): {open_buckets:,}")
    if report["unknown_cities"]:
        print("  cities with no engine schedule (hour buckets left null): " + ", ".join(report["unknown_cities"]))
    print(
        f"\n  Seoul check: compared {report['seoul_compared']:,} bracket-hours, "
        f"rank mismatches {report['seoul_rank_mismatch']:,}, "
        f"ignored city-day-method-hours with no closing tick {report['seoul_ignored']:,}"
    )
    for line in report["seoul_examples"]:
        print(f"    e.g. {line}")
    if report["seoul_compared"] and report["seoul_rank_mismatch"] == 0:
        print("  Seoul closing-tick rank matches through-hour rank on every compared hour.")


def write_docs(db, docs):
    if OUT_COLLECTION in PROTECTED:
        sys.exit(f"refusing to write protected collection {OUT_COLLECTION}")
    col = db[OUT_COLLECTION]
    col.create_index(
        [("city", 1), ("local_date", 1), ("bracket", 1), ("method", 1)],
        unique=True,
        name="city_date_bracket_method_unique",
    )
    col.create_index([("method", 1), ("city", 1), ("local_date", 1)], name="method_city_date")
    col.create_index([("local_date", 1)], name="local_date")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    for doc in docs:
        doc["computed_at"] = now
    for i in range(0, len(docs), BATCH):
        batch = docs[i:i + BATCH]
        col.bulk_write(
            [
                ReplaceOne(
                    {
                        "city": d["city"],
                        "local_date": d["local_date"],
                        "bracket": d["bracket"],
                        "method": d["method"],
                    },
                    d,
                    upsert=True,
                )
                for d in batch
            ],
            ordered=False,
        )
        print(f"  upserted {min(i + BATCH, len(docs)):,}/{len(docs):,}", flush=True)
    print(f"Wrote {len(docs):,} documents to {OUT_COLLECTION}.")


def connect():
    load_dotenv()
    load_dotenv(".env.local")
    uri = os.environ.get("MONGO_URI")
    if not uri:
        sys.exit("Set MONGO_URI (it is read from .env).")
    name = os.environ.get("DB_NAME") or "weather"
    return MongoClient(uri, serverSelectionTimeoutMS=20000)[name]


def parse_args():
    p = argparse.ArgumentParser(description="Build bet_features. Dry run unless --apply.")
    p.add_argument("--apply", action="store_true", help="write bet_features (default is a dry run)")
    p.add_argument("--city", help="restrict to one city, e.g. seoul")
    p.add_argument("--parity", action="store_true", help="run stage 1 only")
    p.add_argument("--since-days", type=int, default=0,
                   help="build only city-days from the last N UTC days; skips stage 1 (for the server loop)")
    p.add_argument("--loop-seconds", type=int, default=0,
                   help="with --since-days: run again every N seconds, forever")
    return p.parse_args()


def run_incremental(args, db):
    """Window build for the server loop. Stage 1 is skipped: it needs the full history."""
    since = (datetime.now(timezone.utc) - timedelta(days=args.since_days)).strftime("%Y-%m-%d")
    t0 = time.time()
    raw = load_raw(db, args.city, since)
    gate_groups = index_gate_ticks(raw)
    attach_combined(gate_groups)
    signals, first_gate = compute_signals(gate_groups)
    winners, _warnings = collect_winners(raw)
    vote_groups = votes_by_day(raw)
    attach_combined(vote_groups)
    docs, _report = build_bet_docs(vote_groups, signals, first_gate, winners)
    print(f"incremental: {len(docs):,} documents since {since} in {time.time() - t0:.1f}s", flush=True)
    if not args.apply:
        print("DRY RUN: nothing was written.", flush=True)
        return
    write_docs(db, docs)


def main():
    args = parse_args()
    if args.city:
        args.city = args.city.strip().lower()
    print("Worker signal: highest pacing minute >= nominal close among ticks stored")
    print("at the first ready evaluation (captured_at + 60s), then stop. Not the earliest minute.")
    print(f"Mode: {'APPLY' if args.apply else 'DRY RUN'}" + (f"  city={args.city}" if args.city else "  all cities"))
    db = connect()
    if args.since_days > 0:
        while True:
            try:
                run_incremental(args, db)
            except Exception as exc:  # keep the loop alive: the next pass tries again
                print(f"incremental run failed: {exc!r}", flush=True)
                if args.loop_seconds <= 0:
                    raise
            if args.loop_seconds <= 0:
                return
            time.sleep(args.loop_seconds)
    print("Loading raw ticks...")
    raw = load_raw(db, args.city)
    print("Building legacy through-hour arrays...")
    legacy_rows = build_legacy(raw)
    print(f"  rebuilt legacy rows (linear, reciprocal, combined): {len(legacy_rows):,}")
    print("Replaying the live gate...")
    gate_groups = index_gate_ticks(raw)
    attach_combined(gate_groups)
    signals, first_gate = compute_signals(gate_groups)
    ok = run_parity(db, legacy_rows, signals, args.city)
    if not ok:
        sys.exit(1)
    if args.parity:
        print("\n--parity set: stage 2 not started.")
        return
    print("\nStage 2: closing-tick bet documents")
    winners, warnings = collect_winners(raw)
    for line in warnings[:30]:
        print(" ", line)
    if len(warnings) > 30:
        print(f"  ... {len(warnings) - 30} more winner warnings")
    print(f"  resolved city-dates: {len(winners):,}")
    vote_groups = votes_by_day(raw)
    attach_combined(vote_groups)
    docs, report = build_bet_docs(vote_groups, signals, first_gate, winners)
    summarize_docs(docs, report)
    if not args.apply:
        print(f"\nDRY RUN: would write {len(docs):,} documents to {OUT_COLLECTION}. Nothing was written.")
        return
    write_docs(db, docs)


if __name__ == "__main__":
    main()
