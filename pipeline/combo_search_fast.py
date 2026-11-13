#!/usr/bin/env python3
"""
Search bet_features for the Stats Explorer filters with the most train profit.

Dimensions and bucket edges follow stats-aggregator.ts. The decision bucket and
entry price follow engine.js: as-of filters (rank, leader, lead margin, rank
trend) read bucket n-1, price_at_hour reads bucket n, and the entry is
close_price_cents at the latest of those buckets. Combos with no hour dimension
enter at first_tick_price_cents.

Region is off unless --include-region (the city→region map is not in this repo).
final_rank and final_tick_count are off unless --include-final.

A combo that matches more than 3 distinct brackets on a city-day drops that
whole city-day (worker.ts planBuys). --ignore-cap turns that off.

Hour dimensions are rank, leader, lead margin, rank trend, and price_at_hour.
Combos with none of those are reported apart from the ranked list: their entry
is the first tick, and the bracket cap sees the whole day. The parent of an
hour combo is the same base at the same decision bucket with no extra filter:
every bracket priced at that closing tick, the same gate, and the 3-bracket
cap counted on the brackets present at that tick. Dates split 60/20/20 into
train, validate, and final. Final is printed only for combos that pass
validate. Dedupe keeps combined, then linear, then reciprocal.

Speed (this version)
--------------------
The scoring rules above are unchanged. What changed is how the work is done.

  Same answers as before (exact):
    * Rows are sorted by (period, city-day, bracket, method). Every bet and
      every city-day is then one contiguous run, and a combo is carried as a
      short array of row numbers, not a full-length mask. The 3-bracket cap
      and the dedupe become a few vector operations on that short array.
    * Per-bet profit is worked out once per decision bucket (win: 100 - price,
      lose: -price). A combo's profit is a sum over its rows.
    * All cities and all city+method groups of a combo are scored in one
      pass (one bincount over a group code), not one loop per city.
    * Parent stats are computed once per bucket / prefix and cached, not
      recomputed for every combo and group.
    * The first dimension is split across --workers processes. Each worker
      returns its de-duplicated combos and the parent merges them, keeping the
      same "shortest combo wins, then first found" rule as before.

  Approximate, on by default (turn off with --screen-top 0):
    * Screen cheaply, then check carefully. Every combo gets a quick score
      (best train profit over the all / city / city+method groups, after cap
      and dedupe, on row-number arrays). Only the best --screen-top combos
      (per class: hour combos, no-hour combos) get the full treatment: city-day
      clustered standard errors, edge over parent, no-cap comparison, CSV rows.
      The CSV therefore holds the screened combos, not every combo.

  Smaller search, results change (off by default; --fast turns all three on):
    * --min-bets 100      raise the minimum train bets from 30
    * --price-widths 20,50  fewer first-tick price widths
    * --no-mixed-hours    hour dimensions in one combo must share one bucket
"""
from __future__ import annotations

import argparse
import hashlib
import math
import multiprocessing as mp
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from math import erfc, sqrt

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from pymongo import MongoClient


def fmt_elapsed(sec: float) -> str:
    if sec < 60:
        return f"{sec:.1f}s"
    m, s = divmod(sec, 60)
    if m < 60:
        return f"{int(m)}m {s:04.1f}s"
    h, m = divmod(m, 60)
    return f"{int(h)}h {int(m)}m {s:04.1f}s"


@contextmanager
def timed(label: str):
    t0 = time.perf_counter()
    try:
        yield
    finally:
        print(f"  [{label}: {fmt_elapsed(time.perf_counter() - t0)}]", flush=True)


HOUR_LABELS = ["8AM", "9AM", "10AM", "11AM", "12PM", "1PM", "2PM", "3PM", "4PM", "5PM"]
DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
PRICE_WIDTHS = (10, 20, 25, 50)
Z95 = 1.959963984540054
METHOD_CODE = {"combined": 0, "linear": 1, "reciprocal": 2}
BASE_ONLY = {"city", "method"}


def wilson_lower(wins: float, n: int) -> float:
    if n <= 0:
        return float("nan")
    phat = wins / n
    z2 = Z95 * Z95
    denom = 1.0 + z2 / n
    centre = phat + z2 / (2.0 * n)
    margin = Z95 * math.sqrt(phat * (1.0 - phat) / n + z2 / (4.0 * n * n))
    return (centre - margin) / denom


def wilson_lower_vec(wins, n):
    """wilson_lower over arrays; NaN where n == 0."""
    n = np.asarray(n, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        phat = wins / n
        z2 = Z95 * Z95
        denom = 1.0 + z2 / n
        centre = phat + z2 / (2.0 * n)
        margin = Z95 * np.sqrt(phat * (1.0 - phat) / n + z2 / (4.0 * n * n))
        return (centre - margin) / denom


def connect():
    load_dotenv()
    uri = os.environ.get("MONGO_URI")
    if not uri:
        sys.exit("Set MONGO_URI (it is read from .env).")
    return MongoClient(uri, serverSelectionTimeoutMS=20000)[os.environ.get("DB_NAME", "weather")]


def _num_list(value, n=10):
    out = np.full(n, np.nan)
    if not isinstance(value, list):
        return out
    for i, v in enumerate(value[:n]):
        if isinstance(v, bool) or v is None:
            continue
        if isinstance(v, (int, float)) and math.isfinite(v):
            out[i] = float(v)
    return out


def _bool_list(value, n=10):
    out = np.zeros(n, dtype=bool)
    if not isinstance(value, list):
        return out
    for i, v in enumerate(value[:n]):
        out[i] = bool(v) if v is not None else False
    return out


def load_frame(db, city, max_date=None):
    query = {}
    if city:
        query["city"] = city
    if max_date:
        query["local_date"] = {"$lte": max_date}
    proj = {"_id": 0}
    docs = list(db["bet_features"].find(query, proj, batch_size=5000))
    if not docs:
        sys.exit("bet_features is empty. Run: python build_bet_features.py --apply")
    return docs


def build_columns(docs):
    n = len(docs)
    city = np.array([str(d["city"]) for d in docs])
    method = np.array([str(d["method"]) for d in docs])
    bracket = np.array([str(d["bracket"]) for d in docs])
    local_date = np.array([str(d["local_date"]) for d in docs])
    resolved = np.array([bool(d.get("resolved")) and d.get("won") is not None for d in docs])
    won = np.zeros(n, dtype=float)
    for i, d in enumerate(docs):
        if resolved[i]:
            won[i] = 1.0 if d.get("won") else 0.0
    fth = np.full(n, -1, dtype=int)
    ftp = np.full(n, np.nan)
    has_price = np.zeros(n, dtype=bool)
    ft_gate = np.zeros(n, dtype=bool)
    final_rank = np.full(n, np.nan)
    final_ticks = np.full(n, np.nan)
    close = np.full((n, 10), np.nan)
    first_px = np.full((n, 10), np.nan)
    rank = np.full((n, 10), np.nan)
    leader = np.full((n, 10), -1, dtype=int)
    margin = np.full((n, 10), np.nan)
    ticks = np.full((n, 10), np.nan)
    gate = np.zeros((n, 10), dtype=bool)
    close_ts = [[None] * 10 for _ in range(n)]
    for i, d in enumerate(docs):
        if isinstance(d.get("first_tick_hour"), (int, float)) and not isinstance(d.get("first_tick_hour"), bool):
            fth[i] = int(d["first_tick_hour"])
        if isinstance(d.get("first_tick_price_cents"), (int, float)) and not isinstance(d.get("first_tick_price_cents"), bool):
            ftp[i] = float(d["first_tick_price_cents"])
        has_price[i] = bool(d.get("has_price")) and math.isfinite(ftp[i])
        ft_gate[i] = bool(d.get("first_tick_gate_open"))
        if isinstance(d.get("final_rank"), (int, float)) and not isinstance(d.get("final_rank"), bool):
            final_rank[i] = float(d["final_rank"])
        if isinstance(d.get("final_tick_count"), (int, float)) and not isinstance(d.get("final_tick_count"), bool):
            final_ticks[i] = float(d["final_tick_count"])
        close[i] = _num_list(d.get("close_price_cents"))
        first_px[i] = _num_list(d.get("hour_first_price_cents"))
        rank[i] = _num_list(d.get("rank"))
        ticks[i] = _num_list(d.get("tick_count"))
        margin[i] = _num_list(d.get("lead_margin"))
        gate[i] = _bool_list(d.get("gate_open"))
        leaders = d.get("is_leader") or []
        for h, v in enumerate(leaders[:10]):
            if v is None:
                leader[i, h] = -1
            else:
                leader[i, h] = 1 if v else 0
        cts = d.get("close_ts") or []
        for h, v in enumerate(cts[:10]):
            close_ts[i][h] = v
    # stats-aggregator: Date(local_date + "T12:00:00Z").getUTCDay(), Sunday=0.
    # pandas dayofweek is Monday=0 … Sunday=6.
    dow = np.empty(n, dtype=object)
    for i, ds in enumerate(local_date):
        try:
            # UTC noon, Sunday=0, matching stats-aggregator getUTCDay.
            weekday = datetime.strptime(str(ds), "%Y-%m-%d").weekday()
            dow[i] = DOW_NAMES[(weekday + 1) % 7]
        except Exception:
            dow[i] = None
    bet_key = np.array([f"{c}|{dt}|{b}" for c, dt, b in zip(city, local_date, bracket)])
    cd_key = np.array([f"{c}|{dt}" for c, dt in zip(city, local_date)])
    bet_id, _ = pd.factorize(bet_key, sort=False)
    city_date_id, _ = pd.factorize(cd_key, sort=False)
    bracket_id, _ = pd.factorize(bracket, sort=False)
    city_code, city_names = pd.factorize(city, sort=False)
    method_code = np.array([METHOD_CODE.get(m, 9) for m in method], dtype=int)
    method_pairs = []
    seen_codes = set()
    for code, name in zip(method_code.tolist(), method.tolist()):
        code = int(code)
        if code in seen_codes:
            continue
        seen_codes.add(code)
        method_pairs.append((code, str(name)))
    method_pairs.sort()
    return {
        "n": n,
        "city": city,
        "method": method,
        "bracket": bracket,
        "local_date": local_date,
        "resolved": resolved,
        "won": won,
        "fth": fth,
        "ftp": ftp,
        "has_price": has_price,
        "ft_gate": ft_gate,
        "final_rank": final_rank,
        "final_ticks": final_ticks,
        "close": close,
        "first_px": first_px,
        "rank": rank,
        "leader": leader,
        "margin": margin,
        "ticks": ticks,
        "gate": gate,
        "close_ts": close_ts,
        "dow": dow,
        "bet_id": bet_id.astype(np.int64),
        "city_date_id": city_date_id.astype(np.int64),
        "bracket_id": bracket_id.astype(np.int64),
        "city_code": city_code.astype(np.int64),
        "city_names": list(city_names),
        "method_code": method_code,
        "method_pairs": method_pairs,
        "n_brackets": int(bracket_id.max()) + 1 if n else 1,
        "n_cd": int(city_date_id.max()) + 1 if n else 1,
        "n_bets": int(bet_id.max()) + 1 if n else 1,
    }


def reorder_columns(col, order):
    """Apply a row permutation to every per-row column."""
    n = col["n"]
    out = {}
    for k, v in col.items():
        if isinstance(v, np.ndarray) and v.ndim >= 1 and v.shape[0] == n:
            out[k] = v[order]
        else:
            out[k] = v
    out["close_ts"] = [col["close_ts"][i] for i in order.tolist()]
    return out


class Atom:
    __slots__ = ("family", "by_id", "value", "bucket", "fth", "mask", "rows")

    def __init__(self, family, by_id, value, bucket, mask, fth=None):
        self.family = family
        self.by_id = by_id
        self.value = value
        self.bucket = bucket
        self.fth = fth
        self.mask = mask
        self.rows = np.flatnonzero(mask)  # row numbers, ascending


def reorder_families(families, order):
    """Permute every atom's mask into the sorted row order. Atom order is unchanged,
    so the search visits combos in the same order the original script did."""
    return [
        [Atom(a.family, a.by_id, a.value, a.bucket, a.mask[order], fth=a.fth) for a in fam]
        for fam in families
    ]


def _atoms_from_labels(family, by_id, labels, bucket=None, fth_of=None):
    atoms = []
    for value in pd.unique(labels):
        if value is None or (isinstance(value, float) and math.isnan(value)):
            continue
        mask = labels == value
        if not mask.any():
            continue
        fth = None if fth_of is None else fth_of
        atoms.append(Atom(family, by_id, str(value), bucket, mask, fth=fth))
    return atoms


def price_labels(prices, width):
    labels = np.empty(prices.shape[0], dtype=object)
    for i, p in enumerate(prices):
        if not math.isfinite(p):
            labels[i] = None
            continue
        lo = math.floor(p / width) * width
        labels[i] = f"{int(lo)}-{int(lo + width - 1)}c"
    return labels


def build_families(col, include_final, price_widths=PRICE_WIDTHS):
    n = col["n"]
    families = []

    families.append(_atoms_from_labels("city", "city", col["city"]))
    families.append(_atoms_from_labels("method", "method", col["method"]))
    families.append(_atoms_from_labels("day_of_week", "day_of_week", col["dow"]))

    fth_labels = np.empty(n, dtype=object)
    for i, h in enumerate(col["fth"]):
        fth_labels[i] = HOUR_LABELS[h] if 0 <= h <= 9 else None
    fth_atoms = []
    for h, label in enumerate(HOUR_LABELS):
        mask = col["fth"] == h
        if mask.any():
            fth_atoms.append(Atom("first_tick_hour", "first_tick_hour", label, None, mask, fth=h))
    families.append(fth_atoms)

    price_atoms = []
    for width in price_widths:
        labels = price_labels(col["ftp"], width)
        labels = np.where(col["has_price"], labels, None)
        for atom in _atoms_from_labels("price", f"price:{width}", labels):
            price_atoms.append(atom)
    families.append(price_atoms)

    rank_atoms = []
    leader_atoms = []
    margin_atoms = []
    trend_atoms = []
    pah_atoms = []
    for hour in range(10):
        if hour >= 1:
            idx = hour - 1
            bucket = idx
            rank_labels = np.empty(n, dtype=object)
            lead_labels = np.empty(n, dtype=object)
            margin_labels = np.empty(n, dtype=object)
            for i in range(n):
                tc = col["ticks"][i, idx]
                rk = col["rank"][i, idx]
                if math.isfinite(tc) and tc > 0 and math.isfinite(rk):
                    r = int(rk)
                    rank_labels[i] = "4+" if r >= 4 else str(r)
                else:
                    rank_labels[i] = None
                if col["leader"][i, idx] >= 0:
                    lead_labels[i] = "Yes" if col["leader"][i, idx] == 1 else "No"
                else:
                    lead_labels[i] = None
                mg = col["margin"][i, idx]
                if math.isfinite(tc) and tc > 0 and math.isfinite(mg):
                    margin_labels[i] = "tight" if mg < 0.15 else "moderate" if mg < 0.40 else "decisive"
                else:
                    margin_labels[i] = None
            rank_atoms.extend(_atoms_from_labels("rank_at_hour", f"rank_at_hour:{hour}", rank_labels, bucket))
            leader_atoms.extend(_atoms_from_labels("leader", f"leader:{hour}", lead_labels, bucket))
            margin_atoms.extend(_atoms_from_labels("lead_margin", f"lead_margin:{hour}", margin_labels, bucket))
        if hour >= 3:
            idx = hour - 1
            prev = idx - 2
            labels = np.empty(n, dtype=object)
            for i in range(n):
                tc0 = col["ticks"][i, idx]
                tc1 = col["ticks"][i, prev]
                a = col["rank"][i, idx]
                b = col["rank"][i, prev]
                if (
                    math.isfinite(tc0) and tc0 > 0 and math.isfinite(tc1) and tc1 > 0
                    and math.isfinite(a) and math.isfinite(b)
                ):
                    labels[i] = "rising" if a < b else "falling" if a > b else "stable"
                else:
                    labels[i] = None
            trend_atoms.extend(_atoms_from_labels("rank_trend", f"rank_trend:{hour}", labels, hour - 1))
        px_labels = price_labels(col["first_px"][:, hour], 20)
        pah_atoms.extend(_atoms_from_labels("price_at_hour", f"price_at_hour:{hour}", px_labels, hour))

    families.extend([rank_atoms, leader_atoms, margin_atoms, trend_atoms, pah_atoms])

    if include_final:
        fr = np.empty(n, dtype=object)
        ft = np.empty(n, dtype=object)
        for i in range(n):
            r = col["final_rank"][i]
            fr[i] = None if not math.isfinite(r) else ("4+" if r >= 4 else str(int(r)))
            c = col["final_ticks"][i]
            if not math.isfinite(c) or c <= 0:
                ft[i] = None
            elif c <= 3:
                ft[i] = "1-3"
            elif c <= 8:
                ft[i] = "4-8"
            elif c <= 16:
                ft[i] = "9-16"
            else:
                ft[i] = "17+"
        families.append(_atoms_from_labels("final_rank", "final_rank", fr))
        families.append(_atoms_from_labels("final_tick_count", "final_tick_count", ft))
    return [fam for fam in families if fam]


# ---------------------------------------------------------------------------
# Original full-mask helpers. The search no longer uses them for every combo,
# but the final top-30 printout and the parent/clustered-diff detail still do,
# and they are the reference the fast path is tested against.
# ---------------------------------------------------------------------------


def decision_bucket(atoms):
    bucket = -1
    for atom in atoms:
        if atom.bucket is not None and atom.bucket > bucket:
            bucket = atom.bucket
    return None if bucket < 0 else bucket


def apply_cap(mask, col):
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return mask, 0
    pair = col["city_date_id"][idx] * col["n_brackets"] + col["bracket_id"][idx]
    uniq = np.unique(pair)
    cd = (uniq // col["n_brackets"]).astype(np.int64)
    cnt = np.bincount(cd, minlength=col["n_cd"])
    bad = cnt > 3
    dropped = int(bad.sum())
    if dropped == 0:
        return mask, 0
    return mask & ~bad[col["city_date_id"]], dropped


def dedupe(mask, col):
    """One row per city|date|bracket. Priority combined, then linear, then reciprocal."""
    if not mask.any():
        return mask
    chosen = np.full(col["n_bets"], 99, dtype=np.int16)
    codes = col["method_code"]
    bids = col["bet_id"]
    for code in (0, 1, 2):
        hit = np.flatnonzero(mask & (codes == code))
        if hit.size == 0:
            continue
        b = bids[hit]
        fresh = chosen[b] == 99
        if fresh.any():
            chosen[b[fresh]] = code
    return mask & (codes == chosen[bids])


def tradable_mask(col, bucket, ignore_gate):
    if bucket is None:
        ok = col["resolved"] & col["has_price"] & np.isfinite(col["ftp"])
        if not ignore_gate:
            ok = ok & col["ft_gate"]
        return ok
    ok = col["resolved"] & np.isfinite(col["close"][:, bucket])
    if not ignore_gate:
        ok = ok & col["gate"][:, bucket]
    return ok


def entry_price(col, bucket):
    if bucket is None:
        return col["ftp"]
    return col["close"][:, bucket]


def _in_period(idx, period):
    if idx.size == 0:
        return idx
    return idx[period[idx]]


def cluster_one(idx, col, price):
    """City-day clustered mean. se matches combo_search: sqrt(ss * G / (G-1)) / n."""
    if idx.size == 0:
        return None
    e_price = price[idx]
    e_won = col["won"][idx]
    edge = np.where(e_won > 0.5, 100.0 - e_price, -e_price)
    cd = col["city_date_id"][idx]
    _uniq, inv = np.unique(cd, return_inverse=True)
    days = int(_uniq.size)
    n = int(idx.size)
    profit = float(edge.sum())
    wins = float(e_won.sum())
    mean = profit / n
    if days > 1:
        sums = np.bincount(inv, weights=edge)
        counts = np.bincount(inv).astype(float)
        resid = sums - mean * counts
        ss = float(np.dot(resid, resid))
        se = math.sqrt(ss * days / (days - 1)) / n
        t = mean / se if se > 0 else float("nan")
    else:
        se = float("nan")
        t = float("nan")
    avg_price = float(e_price.mean())
    return {
        "n": n,
        "days": days,
        "win": wins / n,
        "avg_price": avg_price,
        "avg_edge": mean,
        "profit": profit,
        "t": t,
        "se": se,
        "lcb": 100.0 * wilson_lower(wins, n) - avg_price,
    }


def _cluster_parts(idx, col, price):
    edge = np.where(col["won"][idx] > 0.5, 100.0 - price[idx], -price[idx])
    uniq, inv = np.unique(col["city_date_id"][idx], return_inverse=True)
    sums = np.bincount(inv, weights=edge)
    counts = np.bincount(inv).astype(float)
    return uniq, sums, counts, float(edge.mean()), int(idx.size)


def cluster_diff(idx_a, price_a, idx_b, price_b, col):
    """Clustered SE of mean(a) - mean(b). Clusters are city-days in either set."""
    if idx_a.size == 0 or idx_b.size == 0:
        return float("nan"), float("nan")
    ua, sa, ca, mean_a, na = _cluster_parts(idx_a, col, price_a)
    ub, sb, cb, mean_b, nb = _cluster_parts(idx_b, col, price_b)
    diff = mean_a - mean_b
    left = {int(k): (float(s), float(c)) for k, s, c in zip(ua, sa, ca)}
    right = {int(k): (float(s), float(c)) for k, s, c in zip(ub, sb, cb)}
    keys = set(left) | set(right)
    groups = len(keys)
    if groups < 2:
        return diff, float("nan")
    acc = 0.0
    for key in keys:
        sc, nc = left.get(key, (0.0, 0.0))
        sp, np_ = right.get(key, (0.0, 0.0))
        u = (sc - nc * mean_a) / na - (sp - np_ * mean_b) / nb
        acc += u * u
    return diff, math.sqrt(acc * groups / (groups - 1))


def by_string(base, atoms):
    parts = []
    if base == "city":
        parts.append("city")
    elif base == "city_method":
        parts.extend(["city", "method"])
    for atom in atoms:
        if atom.by_id not in parts:
            parts.append(atom.by_id)
    return ",".join(parts)


def bucket_string(atoms):
    if not atoms:
        return "(all)"
    return " | ".join(f"{a.by_id}={a.value}" for a in atoms)


def prepare_matched(atoms, dim_mask, col):
    matched = dim_mask
    bucket = decision_bucket(atoms)
    if bucket is not None and any(a.family in ("first_tick_hour", "price") for a in atoms):
        matched = matched & (col["fth"] >= 0) & (col["fth"] <= bucket)
    return matched, bucket


def mask_of(atoms, n):
    mask = np.ones(n, dtype=bool)
    for atom in atoms:
        mask = mask & atom.mask
    return mask


def slice_base(mask, col, base, key):
    if base == "all":
        return dedupe(mask, col)
    if base == "city":
        return dedupe(mask & (col["city_code"] == key), col)
    ccode, mcode = key
    return mask & (col["city_code"] == ccode) & (col["method_code"] == mcode)


def hour_parent_label(bucket, base, city, method):
    hour = HOUR_LABELS[bucket]
    if base == "city":
        who = city
    elif base == "city_method":
        who = f"{city} {method}"
    else:
        who = "every bracket"
    return f"{who} priced at the {hour} close"


def parent_index(col, bucket, base, city, method, ignore_gate, ignore_cap):
    """Every bracket priced at this close, same base, same gate, cap on those brackets."""
    key = (bucket, base, city, method, bool(ignore_gate), bool(ignore_cap))
    hit = parent_index.cache.get(key)
    if hit is not None:
        return hit
    present = np.isfinite(col["close"][:, bucket])
    if base == "city":
        present = present & (col["city"] == city)
    elif base == "city_method":
        present = present & (col["city"] == city) & (col["method"] == method)
    if not ignore_cap:
        present, _dropped = apply_cap(present, col)
    if not ignore_gate:
        present = present & col["gate"][:, bucket]
    present = present & col["resolved"]
    if base == "city_method":
        idx = np.flatnonzero(present)
    else:
        idx = np.flatnonzero(dedupe(present, col))
    parent_index.cache[key] = idx
    return idx


parent_index.cache = {}


def parent_of(atoms, base, key):
    """No-hour combos only: drop the last dimension. City/method-only compares with all bets."""
    if not atoms:
        if base == "all":
            return None
        return [], "all", None
    if all(a.family in BASE_ONLY for a in atoms):
        return [], "all", None
    return list(atoms[:-1]), base, key


def parent_label(p_atoms, p_base):
    if not p_atoms and p_base == "all":
        return "(all bets)"
    if not p_atoms:
        return f"(all bets in this {p_base})"
    return bucket_string(p_atoms)


# ---------------------------------------------------------------------------
# Fast search engine
#
# Rows are sorted by (period, city-day, bracket, method). Every bet and every
# city-day is then a contiguous run, so for a short ascending array of row
# numbers the 3-bracket cap and the dedupe are a few vector operations, and
# the train rows are simply the first ones (rows < n_train).
#
# Group codes used when scoring a combo in one pass:
#   0                      all cities, one row per bet (deduped)
#   1 .. C                 one city, deduped
#   1+C + city*MCN+method  one city and one method, not deduped
# ---------------------------------------------------------------------------


class _State:
    """Shared by every worker: forked (no copy) or pickled once under spawn."""


S = _State()
_PCACHE = {}  # per-process cache of no-hour parent stats, keyed by atom-id tuple


def _init_worker(state):
    global S
    S = state
    _PCACHE.clear()


def build_engine(col, families, n_train, n_tv, args, objective):
    n = col["n"]
    st = S
    st.n = n
    st.n_train = int(n_train)
    st.n_tv = int(n_tv)
    st.min_bets = int(args.min_bets)
    st.max_dims = int(args.max_dims)
    st.cap = not args.ignore_cap
    st.ignore_gate = bool(args.ignore_gate)
    st.no_mixed = bool(args.no_mixed_hours)
    st.screen_top = int(args.screen_top)
    st.trim_at = max(20 * st.screen_top, 50000)
    st.objective = objective
    st.city = col["city_code"]
    st.mc = col["method_code"]
    st.bet = col["bet_id"]
    st.cd = col["city_date_id"]
    st.n_cd = col["n_cd"]
    st.city_names = col["city_names"]
    st.n_city = max(len(col["city_names"]), 1)
    st.mcn = int(col["method_code"].max()) + 1 if n else 1
    st.method_pairs = col["method_pairs"]
    st.method_name = {int(c): nm for c, nm in col["method_pairs"]}
    st.cb = 1 + st.n_city
    st.n_groups = st.cb + st.n_city * st.mcn
    st.all_rows = np.arange(n)
    st.res = col["resolved"]
    st.won = col["won"]
    st.rtf = st.res & (st.all_rows < st.n_train)

    # Per decision bucket (0..9 hour closes, 10 = first tick): who can be
    # traded, at what price, and what each bet makes. Built once.
    trade = np.zeros((11, n), dtype=bool)
    price = np.full((11, n), np.nan)
    profit = np.zeros((11, n))
    price_ok = np.zeros((11, n), dtype=bool)
    gate_ok = np.zeros((11, n), dtype=bool)
    for b in range(10):
        price[b] = col["close"][:, b]
        price_ok[b] = np.isfinite(price[b])
        gate_ok[b] = col["gate"][:, b]
    price[10] = col["ftp"]
    price_ok[10] = col["has_price"] & np.isfinite(col["ftp"])
    gate_ok[10] = col["ft_gate"]
    for k in range(11):
        ok = st.res & price_ok[k]
        if not st.ignore_gate:
            ok = ok & gate_ok[k]
        trade[k] = ok
        edge = np.where(st.won > 0.5, 100.0 - price[k], -price[k])
        profit[k] = np.where(ok, edge, 0.0)
    st.trade, st.price, st.profit = trade, price, profit
    st.price_ok, st.gate_ok = price_ok, gate_ok
    st.fthok = [(col["fth"] >= 0) & (col["fth"] <= b) for b in range(10)]

    # Flat atom list in the original depth-first order. An atom with fewer than
    # min_bets resolved train rows can never pass the prune, so it is dropped.
    flat, fam = [], []
    for fi, family in enumerate(families):
        for atom in family:
            if np.count_nonzero(atom.mask & st.rtf) >= st.min_bets:
                flat.append(atom)
                fam.append(fi)
    st.flat = flat
    st.na = len(flat)
    st.a_mask = [a.mask for a in flat]
    st.a_rows = [a.rows for a in flat]
    st.a_bucket = [-1 if a.bucket is None else int(a.bucket) for a in flat]
    st.a_isfp = [a.family in ("first_tick_hour", "price") for a in flat]
    st.a_base_only = [a.family in BASE_ONLY for a in flat]
    fam_arr = np.array(fam, dtype=np.int64)
    st.next_start = [int(np.searchsorted(fam_arr, f, side="right")) for f in fam]

    _PCACHE.clear()
    st.hpar = {}
    for b in sorted({x for x in st.a_bucket if x >= 0}):
        st.hpar[b] = _hour_parent(b)


# --- row-number versions of cap and dedupe ---------------------------------


def _cap_rows(idx, want_days=False):
    """Drop whole city-days where the rows touch more than 3 distinct brackets."""
    S_ = S
    if idx.size == 0:
        return (idx, 0) if want_days else idx
    bet = S_.bet[idx]
    first = np.empty(idx.size, dtype=bool)
    first[0] = True
    np.not_equal(bet[1:], bet[:-1], out=first[1:])
    cd = S_.cd[idx]
    cnt = np.bincount(cd[first], minlength=S_.n_cd)
    bad = cnt > 3
    nbad = int(np.count_nonzero(bad))
    if nbad:
        idx = idx[~bad[cd]]
    return (idx, nbad) if want_days else idx


def _dedupe_rows(idx):
    """One row per bet: the lowest method code (combined, linear, reciprocal)."""
    S_ = S
    if idx.size == 0:
        return idx
    m = S_.mc[idx]
    if m.max() > 2:  # unknown methods are never picked
        keep = m <= 2
        idx = idx[keep]
        m = m[keep]
        if idx.size == 0:
            return idx
    bet = S_.bet[idx]
    first = np.empty(idx.size, dtype=bool)
    first[0] = True
    np.not_equal(bet[1:], bet[:-1], out=first[1:])
    if first.all():
        return idx
    grp = np.cumsum(first) - 1
    return idx[m == m[first][grp]]


def _match(ids):
    """Rows matching a combo's dimensions, its decision bucket (-1 = none)."""
    S_ = S
    bucket = -1
    restrict = False
    for i in ids:
        if S_.a_bucket[i] > bucket:
            bucket = S_.a_bucket[i]
        restrict = restrict or S_.a_isfp[i]
    if ids:
        m = S_.a_rows[ids[0]]
        for i in ids[1:]:
            m = m[S_.a_mask[i][m]]
    else:
        m = S_.all_rows
    if restrict and bucket >= 0:
        m = m[S_.fthok[bucket][m]]
    return m, bucket


# --- stage 1: cheap screen on row-number arrays ------------------------------


def _screen_score(d, s, bk):
    """Best train result over the all / city / city+method groups (n >= min_bets)."""
    S_ = S
    nt = S_.n_train
    mn = S_.min_bets
    prof = S_.profit[bk]
    td = d[: np.searchsorted(d, nt)]
    ts = s[: np.searchsorted(s, nt)]
    pd_ = prof[td]
    ps_ = prof[ts]
    cg = S_.city[td]
    mg = S_.city[ts] * S_.mcn + S_.mc[ts]
    nc = S_.n_city
    nm = nc * S_.mcn
    n1 = np.bincount(cg, minlength=nc)
    s1 = np.bincount(cg, weights=pd_, minlength=nc)
    n2 = np.bincount(mg, minlength=nm)
    s2 = np.bincount(mg, weights=ps_, minlength=nm)
    if S_.objective == "profit":
        best = float(pd_.sum())
        ok = n1 >= mn
        if ok.any():
            best = max(best, float(s1[ok].max()))
        ok = n2 >= mn
        if ok.any():
            best = max(best, float(s2[ok].max()))
        return best
    # all-dates mode ranks by edge minus 2 SE; screen on a naive version of it
    q1 = np.bincount(cg, weights=pd_ * pd_, minlength=nc)
    q2 = np.bincount(mg, weights=ps_ * ps_, minlength=nm)

    def lower(n, a, q):
        ok = n >= mn
        if not ok.any():
            return -np.inf
        nn = n[ok].astype(float)
        mean = a[ok] / nn
        var = np.maximum(q[ok] / nn - mean * mean, 0.0) * nn / np.maximum(nn - 1.0, 1.0)
        return float((mean - 2.0 * np.sqrt(var / nn)).max())

    best = lower(np.array([td.size]), np.array([pd_.sum()]), np.array([(pd_ * pd_).sum()]))
    return max(best, lower(n1, s1, q1), lower(n2, s2, q2))


def _trim_dict(d, k, si, hi):
    """Keep the k best scores per class (hour / no-hour). Score at v[si], class at v[hi]."""
    for want in (True, False):
        items = [(v[si], key) for key, v in d.items() if bool(v[hi]) == want]
        if len(items) > k:
            items.sort(key=lambda t: -t[0])
            for _, key in items[k:]:
                del d[key]


def _consider(seen, m, atoms, bucket, restrict, ctr):
    """Gates, cap, dedupe, digest, score. Same order of tests as the original."""
    S_ = S
    ctr[0] += 1
    bk = 10 if bucket < 0 else bucket
    if restrict and bucket >= 0:
        m = m[S_.fthok[bucket][m]]
    trade = S_.trade[bk]
    mn = S_.min_bets
    cut = int(np.searchsorted(m, S_.n_train))
    if cut < mn:
        return
    if np.count_nonzero(trade[m[:cut]]) < mn:
        return
    if S_.cap:
        m = _cap_rows(m)
    s = m[trade[m]]
    d = _dedupe_rows(s)
    if int(np.searchsorted(d, S_.n_train)) < mn:
        return
    digest = hashlib.blake2b(d.tobytes(), digest_size=16).digest()
    prev = seen.get(digest)
    if prev is not None:
        if prev[0] <= len(atoms):  # shortest combo wins, first found on a tie
            return
        seq_first = prev[5]
    else:
        seq_first = ctr[1]
    score = _screen_score(d, s, bk)
    seen[digest] = (len(atoms), atoms, score, bucket >= 0, ctr[1], seq_first)
    ctr[1] += 1
    if S_.screen_top and len(seen) > S_.trim_at:
        _trim_dict(seen, S_.screen_top, 2, 3)


def _rec(seen, idx, start, bucket, restrict, atoms, ctr):
    S_ = S
    mn = S_.min_bets
    a_mask, a_bucket, a_isfp, rtf = S_.a_mask, S_.a_bucket, S_.a_isfp, S_.rtf
    nomix = S_.no_mixed
    leaf = len(atoms) + 1 >= S_.max_dims
    nxt = S_.next_start
    for a in range(start, S_.na):
        ab = a_bucket[a]
        if nomix and bucket >= 0 and ab >= 0 and ab != bucket:
            continue
        child = idx[a_mask[a][idx]]
        if child.size < mn or np.count_nonzero(rtf[child]) < mn:
            continue
        nb = ab if ab > bucket else bucket
        nr = restrict or a_isfp[a]
        nat = atoms + (a,)
        _consider(seen, child, nat, nb, nr, ctr)
        if not leaf:
            _rec(seen, child, nxt[a], nb, nr, nat, ctr)


def _dfs_task(a0):
    """Everything under one first-dimension atom. Returns its de-duplicated combos."""
    S_ = S
    seen = {}
    ctr = [0, 0]  # visited, sequence
    idx = S_.a_rows[a0]
    bucket = S_.a_bucket[a0]
    restrict = S_.a_isfp[a0]
    atoms = (a0,)
    _consider(seen, idx, atoms, bucket, restrict, ctr)
    if S_.max_dims > 1:
        _rec(seen, idx, S_.next_start[a0], bucket, restrict, atoms, ctr)
    if S_.screen_top:
        _trim_dict(seen, S_.screen_top, 2, 3)
    return a0, [(dg, *v) for dg, v in seen.items()], ctr[0]


def _merge(merged, a0, entries, k):
    """Global dedupe. Shortest combo wins; ties go to the one the serial search met first."""
    for dg, na, atoms, score, hh, seq, seq_first in entries:
        fk = (a0, seq_first)
        cur = merged.get(dg)
        if cur is None:
            merged[dg] = [na, a0, seq, atoms, score, hh, fk]
            continue
        if (na, a0, seq) < (cur[0], cur[1], cur[2]):
            cur[0:6] = [na, a0, seq, atoms, score, hh]
        if fk < cur[6]:
            cur[6] = fk
    if k and len(merged) > 40 * k:
        _trim_dict(merged, k, 4, 5)


# --- stage 2: careful scoring of the survivors -------------------------------


def _assemble(d, s, lo, hi):
    """Rows and group codes for the all, city and city+method groups, rows in [lo, hi)."""
    S_ = S
    d_p = d[np.searchsorted(d, lo): np.searchsorted(d, hi)]
    s_p = s[np.searchsorted(s, lo): np.searchsorted(s, hi)]
    rows = np.concatenate((d_p, d_p, s_p))
    g = np.concatenate((
        np.zeros(d_p.size, dtype=np.int64),
        1 + S_.city[d_p],
        S_.cb + S_.city[s_p] * S_.mcn + S_.mc[s_p],
    ))
    return rows, g


def _gstats(rows, g, bk, full):
    """Per-group n, mean edge and (if full) city-day clustered SE, all groups at once."""
    S_ = S
    G = S_.n_groups
    prof = S_.profit[bk][rows]
    n = np.bincount(g, minlength=G)
    profit = np.bincount(g, weights=prof, minlength=G)
    nn = np.maximum(n, 1)
    mean = np.where(n > 0, profit / nn, np.nan)
    out = {"n": n, "profit": profit, "mean": mean}
    if not full:
        return out
    wins = np.bincount(g, weights=S_.won[rows], minlength=G)
    psum = np.bincount(g, weights=S_.price[bk][rows], minlength=G)
    key = g * S_.n_cd + S_.cd[rows]
    uniq, inv = np.unique(key, return_inverse=True)
    csum = np.bincount(inv, weights=prof)
    ccnt = np.bincount(inv)
    cg = uniq // S_.n_cd
    days = np.bincount(cg, minlength=G)
    resid = csum - mean[cg] * ccnt
    ss = np.bincount(cg, weights=resid * resid, minlength=G)
    with np.errstate(divide="ignore", invalid="ignore"):
        se = np.where(days > 1, np.sqrt(ss * days / np.maximum(days - 1, 1)) / nn, np.nan)
        t = np.where((days > 1) & (se > 0), mean / se, np.nan)
        avg_price = np.where(n > 0, psum / nn, np.nan)
        win = np.where(n > 0, wins / nn, np.nan)
    out.update(days=days, se=se, t=t, avg_price=avg_price, win=win,
               lcb=100.0 * wilson_lower_vec(wins, n) - avg_price)
    return out


def _means_block(d, s, bk):
    """Train and validate (n, mean edge) for every group."""
    S_ = S
    res = {}
    for name, lo, hi in (("tr", 0, S_.n_train), ("va", S_.n_train, S_.n_tv)):
        rows, g = _assemble(d, s, lo, hi)
        st = _gstats(rows, g, bk, False)
        res[name] = (st["n"], st["mean"])
    return res


def _scored_sets(ids):
    """(deduped rows, un-deduped rows, matched rows, bucket, bucket key, cap-dropped city-days)."""
    S_ = S
    m, bucket = _match(ids)
    bk = 10 if bucket < 0 else bucket
    trade = S_.trade[bk]
    if S_.cap:
        capped, bad_days = _cap_rows(m, True)
    else:
        capped, bad_days = m, 0
    s = capped[trade[capped]]
    return _dedupe_rows(s), s, m, bucket, bk, bad_days


def _hour_parent(b):
    """Every bracket priced at close b, same gate, cap counted on those brackets."""
    S_ = S
    present = np.flatnonzero(S_.price_ok[b])
    trade = S_.trade[b]
    pa = _cap_rows(present) if S_.cap else present
    d = _dedupe_rows(pa[trade[pa]])
    parts = []
    for mcode, _name in S_.method_pairs:
        pm = present[S_.mc[present] == mcode]
        if S_.cap:
            pm = _cap_rows(pm)  # the city+method parent counts that method's brackets only
        parts.append(pm[trade[pm]])
    s = np.sort(np.concatenate(parts)) if parts else present[:0]
    return _means_block(d, s, b)


def _means_for(ids):
    """Parent stats for a no-hour prefix, cached."""
    hit = _PCACHE.get(ids)
    if hit is None:
        d, s, _m, _bucket, bk, _bad = _scored_sets(ids)
        hit = _means_block(d, s, bk)
        _PCACHE[ids] = hit
    return hit


def _glabel(gi):
    S_ = S
    if gi == 0:
        return "all", "*", "*"
    if gi < S_.cb:
        return "city", S_.city_names[gi - 1], "*"
    c, mcode = divmod(gi - S_.cb, S_.mcn)
    return "city_method", S_.city_names[c], S_.method_name.get(mcode, "?")


def _group_rows(gi, d, s):
    S_ = S
    if gi == 0:
        return d
    if gi < S_.cb:
        return d[S_.city[d] == gi - 1]
    c, mcode = divmod(gi - S_.cb, S_.mcn)
    return s[(S_.city[s] == c) & (S_.mc[s] == mcode)]


def _eval_combo(ids):
    """Full row set for one combo: every group with enough train bets."""
    S_ = S
    mn = S_.min_bets
    ntr, ntv = S_.n_train, S_.n_tv
    d, s, m, bucket, bk, bad_days = _scored_sets(ids)
    trade = S_.trade[bk]
    nocap_s = m[trade[m]]
    nd = _dedupe_rows(nocap_s)
    tr = _gstats(*_assemble(d, s, 0, ntr), bk, True)
    va = _gstats(*_assemble(d, s, ntr, ntv), bk, True)
    nc = _gstats(*_assemble(nd, nocap_s, 0, ntr), bk, False)

    # diagnostics (train row-hits, as the original printed)
    r = m[S_.res[m]]
    r = r[: np.searchsorted(r, ntr)]
    pok = S_.price_ok[bk][r]
    drop_price = int(np.count_nonzero(~pok))
    drop_gate = 0 if S_.ignore_gate else int(np.count_nonzero(pok & ~S_.gate_ok[bk][r]))
    cap_bets = int(nocap_s.size - s.size) if S_.cap else 0
    diag = (drop_price, drop_gate, bad_days, cap_bets)

    atoms = [S_.flat[i] for i in ids]
    bstr = bucket_string(atoms)
    has_hour = bucket >= 0
    if has_hour:
        P = S_.hpar[bucket]
    else:
        base_only = all(S_.a_base_only[i] for i in ids)
        P_root = _means_for(()) if base_only else None
        P_same = None if base_only else _means_for(ids[:-1])

    out = []
    nan = float("nan")
    for gi in np.flatnonzero(tr["n"] >= mn).tolist():
        base, city_label, method_label = _glabel(gi)
        # parent
        if has_hour:
            PP, pgi = P, gi
            p_label = hour_parent_label(bucket, base, city_label, method_label)
        elif not ids and base == "all":
            PP, pgi, p_label = None, 0, ""
        elif base_only:
            PP, pgi, p_label = P_root, 0, "(all bets)"
        else:
            PP, pgi, p_label = P_same, gi, parent_label(atoms[:-1], base)
        n_va = int(va["n"][gi])
        va_mean = float(va["mean"][gi]) if n_va > 0 else nan
        if PP is None:
            eop_tr = eop_va = nan
        else:
            ptr_n, ptr_m = PP["tr"]
            pva_n, pva_m = PP["va"]
            eop_tr = float(tr["mean"][gi] - ptr_m[pgi]) if ptr_n[pgi] > 0 else nan
            eop_va = float(va_mean - pva_m[pgi]) if (n_va > 0 and pva_n[pgi] > 0) else nan
        n_nocap = int(nc["n"][gi])
        grp = _group_rows(gi, d, s)
        out.append({
            "city": city_label,
            "method": method_label,
            "base": base,
            "by": by_string(base, atoms),
            "bucket": bstr,
            "atoms_ids": ids,
            "decision": bucket if has_hour else None,
            "has_hour": has_hour,
            "n_atoms": len(ids),
            "parent": p_label,
            "edge_over_parent_tr": eop_tr,
            "edge_over_parent_va": eop_va,
            "bet_set": hashlib.blake2b(grp.tobytes(), digest_size=16).hexdigest(),
            "n_tr": int(tr["n"][gi]),
            "city_days_tr": int(tr["days"][gi]),
            "win_tr": float(tr["win"][gi]),
            "avg_price_tr": float(tr["avg_price"][gi]),
            "avg_edge_tr": float(tr["mean"][gi]),
            "total_profit_tr": float(tr["profit"][gi]),
            "t_tr": float(tr["t"][gi]),
            "se_tr": float(tr["se"][gi]),
            "edge_lcb_tr": float(tr["lcb"][gi]),
            "n_va": n_va,
            "city_days_va": int(va["days"][gi]) if n_va > 0 else 0,
            "win_va": float(va["win"][gi]) if n_va > 0 else nan,
            "avg_price_va": float(va["avg_price"][gi]) if n_va > 0 else nan,
            "avg_edge_va": va_mean,
            "total_profit_va": float(va["profit"][gi]) if n_va > 0 else 0.0,
            "t_va": float(va["t"][gi]) if n_va > 0 else nan,
            "edge_lcb_va": float(va["lcb"][gi]) if n_va > 0 else nan,
            "n_nocap": n_nocap,
            "edge_nocap": float(nc["mean"][gi]) if n_nocap > 0 else nan,
        })
    return out, diag


def _eval_chunk(chunk):
    rows = []
    diag = [0, 0, 0, 0]
    for ids in chunk:
        r, dg = _eval_combo(ids)
        rows.extend(r)
        for j in range(4):
            diag[j] += dg[j]
    return rows, diag


def _top_k(items, k):
    """k best per class (hour / no-hour) by score, plus the all-bets combo."""
    keep = []
    for want in (True, False):
        cls = [v for v in items if bool(v[5]) == want and len(v[3]) > 0]
        cls.sort(key=lambda v: (-v[4], v[6]))
        keep.extend(cls[:k])
    kept = {id(v) for v in keep}
    keep.extend(v for v in items if len(v[3]) == 0 and id(v) not in kept)
    return keep


def search_fast(col, families, args, n_train, n_tv, objective):
    with timed("engine build"):
        build_engine(col, families, n_train, n_tv, args, objective)
    st = S
    k = st.screen_top
    workers = int(args.workers) if args.workers else (os.cpu_count() or 1)
    workers = max(1, min(workers, max(st.na, 1)))
    merged = {}
    visited = 0

    # The empty combo (all bets, first tick) first, as the original did.
    ctr = [0, 0]
    root = {}
    _consider(root, st.all_rows, (), -1, False, ctr)
    visited += ctr[0]
    _merge(merged, -1, [(dg, *v) for dg, v in root.items()], k)

    tasks = sorted(range(st.na), key=lambda a: -len(st.a_rows[a]))
    pool = None
    if workers > 1:
        # fork shares the arrays for free but is only safe on Linux; spawn pickles them once per worker.
        use_fork = sys.platform.startswith("linux") and "fork" in mp.get_all_start_methods()
        pool = mp.get_context("fork" if use_fork else "spawn").Pool(
            workers, initializer=_init_worker, initargs=(S,))
    t_dfs0 = time.perf_counter()
    print(f"  {st.na} first-dimension atoms across {workers} worker(s)", flush=True)
    try:
        it = pool.imap_unordered(_dfs_task, tasks, chunksize=1) if pool else map(_dfs_task, tasks)
        done = 0
        step = max(1, len(tasks) // 10)
        for a0, entries, vis in it:
            visited += vis
            _merge(merged, a0, entries, k)
            done += 1
            if done % step == 0 or done == len(tasks):
                print(f"  {done}/{len(tasks)} first-dimension atoms done, "
                      f"{visited:,} combos visited, {len(merged):,} unique bet-sets held, "
                      f"elapsed {fmt_elapsed(time.perf_counter() - t_dfs0)}", flush=True)

        items = list(merged.values())
        unique_sets = len(items)
        search_fast.visited = visited
        search_fast.unique_sets = unique_sets
        keep = _top_k(items, k) if k else items
        keep.sort(key=lambda v: v[6])  # the order the serial search first met them
        cand = [v[3] for v in keep]
        print(f"  {visited:,} combos visited; {unique_sets:,} unique deduped bet-sets "
              f"(shortest combo kept)", flush=True)
        if k:
            print(f"  screened to the best {k:,} per class by train profit: "
                  f"{len(cand):,} combos get the full check", flush=True)
        print(f"  [dfs + screen: {fmt_elapsed(time.perf_counter() - t_dfs0)}]", flush=True)
        t_full0 = time.perf_counter()
        step = 50
        chunks = [cand[i:i + step] for i in range(0, len(cand), step)]
        results = pool.map(_eval_chunk, chunks, chunksize=1) if pool else [_eval_chunk(c) for c in chunks]
        print(f"  [full check: {fmt_elapsed(time.perf_counter() - t_full0)}]", flush=True)
    except BaseException:
        if pool:
            pool.terminate()  # Ctrl-C or an error: do not wait for queued work
        raise
    finally:
        if pool:
            pool.close()
            pool.join()

    rows = []
    diag = [0, 0, 0, 0]
    for r, dg in results:
        rows.extend(r)
        for j in range(4):
            diag[j] += dg[j]
    for row in rows:
        row["atoms"] = [st.flat[i] for i in row["atoms_ids"]]
    print(f"  null entry price dropped {diag[0]:,} train row-hits across checked combos")
    print(f"  closed gate dropped {diag[1]:,} train row-hits across checked combos")
    print(f"  3-bracket cap dropped {diag[2]:,} combo city-days and {diag[3]:,} tradable bets")
    return rows


def example_bets(col, row, train, ignore_gate, ignore_cap, k=5):
    atoms = row["atoms"]
    matched, bucket = prepare_matched(atoms, mask_of(atoms, col["n"]), col)
    if ignore_cap:
        capped = matched
    else:
        capped, _dropped = apply_cap(matched, col)
    trade = tradable_mask(col, bucket, ignore_gate)
    scored = capped & trade
    if row["base"] == "city":
        scored = dedupe(scored & (col["city"] == row["city"]), col)
    elif row["base"] == "city_method":
        scored = scored & (col["city"] == row["city"]) & (col["method"] == row["method"])
    else:
        scored = dedupe(scored, col)
    idx = np.flatnonzero(scored & train)
    if idx.size < k:
        idx = np.flatnonzero(scored)
    order = idx[np.argsort(col["local_date"][idx], kind="mergesort")][:k]
    price = entry_price(col, bucket)
    bets = []
    for i in order:
        ts = ""
        if bucket is not None:
            ts = col["close_ts"][i][bucket] or ""
        bets.append({
            "i": int(i),
            "city": str(col["city"][i]),
            "local_date": str(col["local_date"][i]),
            "bracket": str(col["bracket"][i]),
            "method": str(col["method"][i]),
            "close_ts": ts,
            "price": float(price[i]),
            "won": bool(col["won"][i] > 0.5),
            "bucket": bucket,
        })
    return bets


def format_bet(bet):
    return (
        f"    {bet['city']}  {bet['local_date']}  {bet['bracket']}  "
        f"close_ts={bet['close_ts']}  price={bet['price']:.0f}  won={bet['won']}  method={bet['method']}"
    )


def collapse_bet_sets(frame):
    ordered = frame.sort_values(["n_atoms", "base"], ascending=[True, True], kind="mergesort")
    return ordered.drop_duplicates("bet_set", keep="first")


def _weeks(date_list):
    if not date_list:
        return float("nan")
    start = datetime.strptime(date_list[0], "%Y-%m-%d")
    end = datetime.strptime(date_list[-1], "%Y-%m-%d")
    return max((end - start).days / 7.0, 1.0 / 7.0)


def _fmt_ci(mean, se):
    if mean is None or not math.isfinite(mean):
        return "n/a"
    if se is None or not math.isfinite(se):
        return f"{mean:.2f} [n/a]"
    lo = mean - Z95 * se
    hi = mean + Z95 * se
    return f"{mean:.2f} [{lo:.2f}, {hi:.2f}]"


def _combo_index(col, row, ignore_gate, ignore_cap):
    atoms = row["atoms"]
    matched, bucket = prepare_matched(atoms, mask_of(atoms, col["n"]), col)
    if ignore_cap:
        capped = matched
    else:
        capped, _dropped = apply_cap(matched, col)
    scored = capped & tradable_mask(col, bucket, ignore_gate)
    if row["base"] == "city":
        scored = dedupe(scored & (col["city"] == row["city"]), col)
    elif row["base"] == "city_method":
        scored = scored & (col["city"] == row["city"]) & (col["method"] == row["method"])
    else:
        scored = dedupe(scored, col)
    return np.flatnonzero(scored), bucket


def report(rows, col, train, validate, final, windows, args):
    mn = args.min_bets
    if not rows:
        sys.exit(f"No combo had {mn} train bets.")
    frame = pd.DataFrame(rows)
    distinct = collapse_bet_sets(frame)
    p = 0.5 * erfc(2 / sqrt(2))
    t_ok = distinct["t_tr"] >= 2
    passed = distinct[t_ok]
    stay = passed[passed["avg_edge_va"] > 0]
    all_base = distinct[distinct["base"] == "all"]
    all_passed = all_base[all_base["t_tr"] >= 2]
    all_stay = all_passed[all_passed["avg_edge_va"] > 0]
    train_dates, val_dates, fin_dates = windows
    print("\nDate split (oldest 60% train, next 20% validate, newest 20% final)")
    print(f"  train    {train_dates[0]} → {train_dates[-1]}  ({len(train_dates)} dates)")
    print(f"  validate {val_dates[0]} → {val_dates[-1]}  ({len(val_dates)} dates)  starts {val_dates[0]}")
    print(f"  final    {fin_dates[0]} → {fin_dates[-1]}  ({len(fin_dates)} dates)  starts {fin_dates[0]}")
    print(f"Scored combo rows with train n >= {mn}: {len(frame):,}")
    print(f"Distinct bet-sets: {len(distinct):,}  (collapsed {len(frame) - len(distinct):,} duplicate sets)")
    if args.screen_top:
        print(f"  (screened: only the best {args.screen_top:,} hour combos and {args.screen_top:,} "
              f"no-hour combos by train profit were fully scored; --screen-top 0 scores them all)")
    print(
        f"Distinct bet-sets with t >= 2 on train: {len(passed):,}   "
        f"expected by chance if edge is 0: {len(distinct) * p:,.1f} "
        f"(one-sided normal, {p:.4f} each)"
    )
    print(f"Of those distinct sets, positive average edge on validate: {len(stay):,}")
    print(
        f"All-rows base only: {len(all_base):,} distinct sets, "
        f"t >= 2: {len(all_passed):,}, expected {len(all_base) * p:,.1f}, "
        f"positive on validate: {len(all_stay):,}"
    )

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "bet_combos.csv")
    csv_cols = [
        "city", "method", "base", "by", "bucket", "has_hour", "parent",
        "n_tr", "city_days_tr", "win_tr", "avg_price_tr", "avg_edge_tr", "total_profit_tr", "t_tr", "edge_lcb_tr",
        "edge_over_parent_tr",
        "n_va", "city_days_va", "win_va", "avg_price_va", "avg_edge_va", "total_profit_va", "t_va", "edge_lcb_va",
        "edge_over_parent_va",
        "n_nocap", "edge_nocap",
    ]
    distinct.sort_values("total_profit_tr", ascending=False)[csv_cols].to_csv(path, index=False)
    print(f"\nWrote {path} ({len(distinct):,} distinct bet-sets with train n >= {mn})")
    print("The CSV has train and validate only. The final period is printed below for the shortlist.")

    no_hour = distinct[~distinct["has_hour"]].sort_values("total_profit_tr", ascending=False)
    print("\n=== not bot-tradable: entry is first tick and the cap uses same-day info ===")
    if no_hour.empty:
        print("  none")
    else:
        view = no_hour.head(15).copy()
        for c in ("avg_edge_tr", "avg_edge_va", "total_profit_tr", "edge_over_parent_tr", "edge_over_parent_va"):
            view[c] = view[c].round(2)
        print(view[["city", "method", "base", "by", "bucket", "n_tr", "n_va", "avg_edge_tr", "avg_edge_va",
                     "total_profit_tr", "edge_over_parent_tr", "edge_over_parent_va", "parent"]].to_string(index=False))

    ranked = distinct[distinct["has_hour"] & (distinct["edge_over_parent_tr"] > 0)].sort_values(
        "total_profit_tr", ascending=False
    )
    short = ranked[(ranked["n_va"] >= 10) & (ranked["edge_over_parent_va"] > 0)]
    print(
        f"\nHour combos with train edge_over_parent > 0: {len(ranked):,}. "
        f"Shortlist (validate n >= 10 and validate edge_over_parent > 0): {len(short):,}."
    )
    print("Ranked by train total profit. Final numbers are only for this shortlist.")
    top = short.head(30)
    if top.empty:
        print("  none passed validate")
        return
    week = {"train": _weeks(train_dates), "validate": _weeks(val_dates), "final": _weeks(fin_dates)}
    periods = (("train", train), ("validate", validate), ("final", final))
    for rank, (_, row) in enumerate(top.iterrows(), start=1):
        idx, bucket = _combo_index(col, row, args.ignore_gate, args.ignore_cap)
        price = entry_price(col, bucket)
        p_idx = parent_index(
            col, int(bucket), row["base"], row["city"], row["method"], args.ignore_gate, args.ignore_cap
        )
        p_price = entry_price(col, int(bucket))
        print(f"\n{rank}. by={row['by']}")
        print(f"   {row['city']} {row['method']}  {row['base']}  {row['bucket']}")
        print(f"   parent: {row['parent']}")
        for name, mask in periods:
            sub = _in_period(idx, mask)
            par = _in_period(p_idx, mask)
            st = cluster_one(sub, col, price)
            if st is None:
                print(f"   {name:<8} n=0")
                continue
            diff, diff_se = cluster_diff(sub, price, par, p_price, col)
            per_week = st["n"] / week[name]
            print(
                f"   {name:<8} n={st['n']:<5}  bets/week={per_week:6.1f}  "
                f"edge {_fmt_ci(st['avg_edge'], st['se'])}  "
                f"edge_over_parent {_fmt_ci(diff, diff_se)}"
            )


def _population_stats(idx, price, won):
    if idx.size == 0:
        return {"n": 0, "win": float("nan"), "avg_price": float("nan"), "avg_edge": float("nan")}
    p = price[idx]
    w = won[idx]
    finite = np.isfinite(p)
    stats = {"n": int(idx.size), "win": float(w.mean())}
    if not finite.any():
        stats["avg_price"] = float("nan")
        stats["avg_edge"] = float("nan")
        return stats
    pf = p[finite]
    wf = w[finite]
    edge = np.where(wf > 0.5, 100.0 - pf, -pf)
    stats["avg_price"] = float(pf.mean())
    stats["avg_edge"] = float(edge.mean())
    return stats


def _dropped_edge(prev_idx, idx, n, price, won):
    if prev_idx is None:
        return 0, float("nan")
    keep = np.zeros(n, dtype=bool)
    keep[idx] = True
    before = np.zeros(n, dtype=bool)
    before[prev_idx] = True
    dropped = np.flatnonzero(before & ~keep)
    stats = _population_stats(dropped, price, won)
    return stats["n"], stats["avg_edge"]


def baseline_audit(col, train):
    """Resolved bets, first-tick entry. Steps are cumulative, in the order requested."""
    price = col["ftp"]
    won = col["won"]
    resolved = col["resolved"]
    groups = [("all", dedupe(resolved, col))]
    for code, name in col["method_pairs"]:
        groups.append((name, resolved & (col["method_code"] == code)))
    print("\n=== BASELINE AUDIT ===")
    print("Resolved bets only. Entry is the first-tick price. 'all' keeps one row per")
    print("city|date|bracket (combined, then linear, then reciprocal).")
    print("Step (a) includes null prices in n and win%; avg price and avg edge use priced bets only.")
    print("The search caps matching brackets before dropping a null price. This audit drops")
    print("the null price first, then caps, because that is the order below.")
    print(f"{'group':<12} {'step':<22} {'n':>7} {'win%':>7} {'avg_px':>8} {'avg_edge':>9} "
          f"{'delta':>8} {'drop_n':>7} {'drop_edge':>10} {'edge_tr':>8}")
    for name, base in groups:
        priced = base & np.isfinite(price)
        capped, dropped_days = apply_cap(priced, col)
        steps = [
            ("a no filters", np.flatnonzero(base)),
            ("b drop null price", np.flatnonzero(priced)),
            ("c plus 3-bracket cap", np.flatnonzero(capped)),
            ("d plus gate", np.flatnonzero(capped & col["ft_gate"])),
        ]
        prev_idx = None
        prev_edge = None
        for label, idx in steps:
            stats = _population_stats(idx, price, won)
            delta = float("nan")
            if prev_edge is not None and math.isfinite(stats["avg_edge"]) and math.isfinite(prev_edge):
                delta = stats["avg_edge"] - prev_edge
            drop_n, drop_edge = _dropped_edge(prev_idx, idx, col["n"], price, won)
            train_stats = _population_stats(idx[train[idx]] if idx.size else idx, price, won)
            print(
                f"{name:<12} {label:<22} {stats['n']:7,} {stats['win'] * 100:7.1f} "
                f"{stats['avg_price']:8.1f} {stats['avg_edge']:9.2f} {delta:8.2f} "
                f"{drop_n:7,} {drop_edge:10.2f} {train_stats['avg_edge']:8.2f}"
            )
            prev_idx = idx
            prev_edge = stats["avg_edge"]
        null_idx = np.flatnonzero(base & ~np.isfinite(price))
        null_win = float(won[null_idx].mean()) if null_idx.size else float("nan")
        print(f"  {name}: null-price n={null_idx.size:,} win%={null_win * 100:.1f}; "
              f"cap dropped {dropped_days:,} city-days")
        search_capped, _days = apply_cap(base, col)
        search_px = search_capped & np.isfinite(price)
        search_gate = search_px & col["ft_gate"]
        s_px = _population_stats(np.flatnonzero(search_px), price, won)
        s_gate = _population_stats(np.flatnonzero(search_gate), price, won)
        print(f"  {name}: search order cap-then-price edge {s_px['avg_edge']:.2f} (n={s_px['n']:,}); "
              f"then gate {s_gate['avg_edge']:.2f} (n={s_gate['n']:,})")


def _clock(hour_bucket, minute):
    hour24 = int(hour_bucket) + 8
    suffix = "AM" if hour24 < 12 else "PM"
    hour12 = hour24 % 12 or 12
    return f"{hour12}:{int(minute):02d} {suffix}"


def _near(a, b, tol=1e-6):
    a_bad = a is None or (isinstance(a, float) and not math.isfinite(a))
    b_bad = b is None or (isinstance(b, float) and not math.isfinite(b))
    if a_bad or b_bad:
        return a_bad and b_bad
    return abs(float(a) - float(b)) <= tol


def verify_bet(db, col, bet):
    import build_bet_features as bf

    city = bet["city"]
    local_date = bet["local_date"]
    method = bet["method"]
    bracket = bet["bracket"]
    bucket = bet["bucket"]
    print(f"\n--- hand check {city} {local_date} {method} {bracket} ---")
    if bucket is None:
        print("  no hour bucket on this bet")
        return
    bucket = int(bucket)
    raw = [r for r in bf.load_raw(db, city) if r["local_date"] == local_date]
    vote_groups = bf.votes_by_day(raw)
    bf.attach_combined(vote_groups)
    votes = vote_groups.get((city, local_date, method), [])
    gate = bf.index_gate_ticks(raw)
    bf.attach_combined(gate)
    signals, _first_gate = bf.compute_signals(gate)
    sigs = signals.get((city, local_date, method))
    signal = None if not sigs else sigs[bucket]
    if signal is None:
        print("  MISMATCH: replay found no ready closing tick")
        return
    _recs, order, _final_rank = bf.reduce_outcomes(votes)
    counts, rank, leader, lead = bf.state_asof(order, votes, signal["epoch"], bucket, signal["minute"])
    price = bf.close_price_for(votes, bracket, bucket, signal["minute"])
    first_px = bf.hour_first_price(votes, bracket, bucket, signal["epoch"], signal["minute"])
    winners, _warnings = bf.collect_winners(raw)
    winner = winners.get((city, local_date))
    won = None if winner is None else bracket == winner
    i = bet["i"]
    stored = {
        "price": col["close"][i, bucket],
        "rank": col["rank"][i, bucket],
        "ticks": col["ticks"][i, bucket],
        "leader": col["leader"][i, bucket],
        "margin": col["margin"][i, bucket],
        "hour_first": col["first_px"][i, bucket],
    }
    print(f"  signal {_clock(bucket, signal['minute'])}  close_ts {bf.iso_from_ms(signal['epoch'])}")
    print(f"  price recomputed {price}  stored {stored['price']}  example {bet['price']:.0f}")
    print(f"  won recomputed {won} (winner {winner})  example {bet['won']}")
    print(f"  rank recomputed {rank.get(bracket)} stored {stored['rank']}  "
          f"ticks {counts.get(bracket)} stored {stored['ticks']}")
    print(f"  leader recomputed {leader.get(bracket)} stored {stored['leader']}  "
          f"lead {lead:.4f} stored {stored['margin']}")
    print(f"  hour_first_price recomputed {first_px} stored {stored['hour_first']}")
    leader_stored = None if stored["leader"] < 0 else bool(stored["leader"] == 1)
    match = (
        _near(price, bet["price"])
        and _near(price, stored["price"])
        and won == bet["won"]
        and _near(rank.get(bracket), stored["rank"])
        and _near(counts.get(bracket), stored["ticks"])
        and leader.get(bracket) == leader_stored
        and _near(lead, stored["margin"])
        and _near(first_px, stored["hour_first"], tol=1e-6)
    )
    print("  MATCH" if match else "  MISMATCH")
    used = [
        v for v in votes
        if v["epoch"] <= signal["epoch"]
        and (v["hour"] < bucket or (v["hour"] == bucket and v["minute"] <= signal["minute"]))
    ]
    signal_ticks = [v for v in used if v["hour"] == bucket and v["minute"] == signal["minute"]]
    show = used if len(used) <= 80 else signal_ticks
    print(f"  ticks used: {len(used)}  (printed {len(show)})")
    if len(used) > 80:
        counts_b = {}
        for v in used:
            counts_b[v["bracket"]] = counts_b.get(v["bracket"], 0) + 1
        summary = ", ".join(f"{b}={n}" for b, n in sorted(counts_b.items(), key=lambda kv: -kv[1]))
        print(f"  earlier ticks omitted; counts at the signal: {summary}")
    price_marked = False
    for v in show:
        meth = "linear" if v["coll"] == 0 else "reciprocal"
        cents = "" if v["cents"] is None else str(v["cents"])
        mark = ""
        on_signal = v["hour"] == bucket and v["minute"] == signal["minute"] and v["bracket"] == bracket
        if on_signal and not price_marked and bf.signal_price(v["cents"], v["yes_price"]) is not None:
            mark = "  <-- price used"
            price_marked = True
        elif on_signal:
            mark = "  <-- signal minute"
        print(f"    {_clock(v['hour'], v['minute'])}  {v['captured_at']}  {meth:11}  {cents:>4}  {v['bracket']}{mark}")


def dataset_drops(col):
    resolved = col["resolved"]
    print(f"\nResolved bets: {int(resolved.sum()):,} of {col['n']:,}")
    no_ft = resolved & ~col["has_price"]
    gate_ft = resolved & col["has_price"] & ~col["ft_gate"]
    print(f"  no first-tick price: {int(no_ft.sum()):,}")
    print(f"  first-tick price present but first-tick gate closed: {int(gate_ft.sum()):,}")
    print("  per hour, resolved bets with null close price / gate closed:")
    for h in range(10):
        null_px = int((resolved & ~np.isfinite(col["close"][:, h])).sum())
        closed = int((resolved & np.isfinite(col["close"][:, h]) & ~col["gate"][:, h]).sum())
        print(f"    {HOUR_LABELS[h]:4}  null close {null_px:5,}   priced but gate closed {closed:5,}")


def report_all_dates(rows, col, dates, args):
    """Rank every combo on all dates at once. No train/validate/final split."""
    mn = args.min_bets
    if not rows:
        sys.exit(f"No combo had {mn} bets.")
    frame = pd.DataFrame(rows)
    distinct = collapse_bet_sets(frame).copy()
    # Edge minus 2 city-day-clustered standard errors.
    distinct["edge_lower"] = distinct["avg_edge_tr"] - 2.0 * distinct["se_tr"]

    print(f"\nAll {len(dates)} dates, {dates[0]} → {dates[-1]}")
    print(f"Scored combo rows with n >= {mn}: {len(frame):,}")
    print(f"Distinct bet-sets: {len(distinct):,}  (collapsed {len(frame) - len(distinct):,} duplicate sets)")
    if args.screen_top:
        print(f"  (screened: only the best {args.screen_top:,} hour combos and {args.screen_top:,} "
              f"no-hour combos were fully scored; --screen-top 0 scores them all)")

    renamed = distinct.rename(columns={
        "n_tr": "n",
        "city_days_tr": "city_days",
        "win_tr": "win",
        "avg_price_tr": "avg_price",
        "avg_edge_tr": "avg_edge",
        "se_tr": "se",
        "total_profit_tr": "total_profit",
        "t_tr": "t",
        "edge_over_parent_tr": "edge_over_parent",
    })
    csv_cols = [
        "city", "method", "base", "by", "bucket", "has_hour", "parent",
        "n", "city_days", "win", "avg_price", "avg_edge", "se", "edge_lower",
        "total_profit", "t", "edge_over_parent", "n_nocap", "edge_nocap",
    ]
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"bet_combos_all_dates_dim{args.max_dims}.csv")
    renamed.sort_values("edge_lower", ascending=False)[csv_cols].to_csv(path, index=False)
    print(f"\nWrote {path} ({len(renamed):,} distinct bet-sets, sorted by edge_lower)")
    n_no_hour = int((~distinct["has_hour"]).sum())
    print(f"{n_no_hour:,} of them have no hour dimension (first-tick entry, not bot-tradable). "
          "They are in the CSV with has_hour = False and left out of the table below.")

    ranked = distinct[distinct["has_hour"]].sort_values("edge_lower", ascending=False)
    top = ranked.head(30)
    print(f"\nTop 30 bot-tradable combos by edge minus 2 SEs, all {len(dates)} dates, n >= {mn}")
    print("Ranked and measured on the same dates, so these are hypotheses, not results.")
    if top.empty:
        print("  none")
        return
    weeks = _weeks(list(dates))
    for rank, (_, row) in enumerate(top.iterrows(), start=1):
        idx, bucket = _combo_index(col, row, args.ignore_gate, args.ignore_cap)
        price = entry_price(col, bucket)
        p_idx = parent_index(
            col, int(bucket), row["base"], row["city"], row["method"], args.ignore_gate, args.ignore_cap
        )
        p_price = entry_price(col, int(bucket))
        st = cluster_one(idx, col, price)
        if st is None:
            continue
        diff, diff_se = cluster_diff(idx, price, p_idx, p_price, col)
        print(f"\n{rank}. by={row['by']}")
        print(f"   {row['city']} {row['method']}  {row['base']}  {row['bucket']}")
        print(f"   parent: {row['parent']}")
        print(
            f"   n={st['n']:<5} bets/week={st['n'] / weeks:6.1f}  win={st['win'] * 100:5.1f}%  "
            f"avg_price={st['avg_price']:5.1f}  edge_lower={row['edge_lower']:.2f}"
        )
        print(
            f"   edge {_fmt_ci(st['avg_edge'], st['se'])}  "
            f"edge_over_parent {_fmt_ci(diff, diff_se)}"
        )


def _announce(args, n_atoms, col):
    print(f"\nSearching up to {args.max_dims} dims, {n_atoms} dimension values, "
          f"bases: all rows, city, city+method")
    print(f"  min bets {args.min_bets}, first-tick price widths {list(args.price_widths)}, "
          f"mixed hours {'off' if args.no_mixed_hours else 'on'}, "
          f"screen top {args.screen_top or 'off (every combo)'}")


def run_all_dates(col, families, dates, args):
    """--all-dates: every date counts, nothing is held out."""
    everything = np.ones(col["n"], dtype=bool)
    print(f"ALL-DATES MODE: {len(dates)} dates, {dates[0]} → {dates[-1]}. No train/validate/final split.")
    print(f"Bets {col['n']:,}")
    with timed("baseline audit"):
        dataset_drops(col)
        baseline_audit(col, everything)
    _announce(args, sum(len(f) for f in families), col)
    rows = search_fast(col, families, args, col["n"], col["n"], "lower")
    with timed("report"):
        report_all_dates(rows, col, dates, args)


def dump_rule(col, families, args):
    """Score ONE rule with the same code as the search and write every bet it scores."""
    import csv

    want = []
    for term in args.dump_rule.split("|"):
        by_id, _, value = term.strip().partition("=")
        if by_id.strip() and value.strip():
            want.append((by_id.strip(), value.strip()))
    if not want:
        sys.exit('--dump-rule needs terms like "lead_margin:7=moderate | leader:2=No"')
    args.min_bets = 1
    args.max_dims = len(want)
    args.workers = 1
    build_engine(col, families, col["n"], col["n"], args, "profit")
    st = S
    ids = []
    for by_id, value in want:
        hit = [i for i, a in enumerate(st.flat) if a.by_id == by_id and a.value == value]
        if not hit:
            sys.exit(f"No rows for rule term: {by_id}={value}")
        ids.append(hit[0])
    ids = tuple(ids)
    d, _s, _m, bucket, bk, _bad = _scored_sets(ids)
    os.makedirs(args.out, exist_ok=True)
    tag = hashlib.md5(args.dump_rule.encode("utf-8")).hexdigest()[:10]
    path = os.path.join(args.out, f"dump_{tag}.csv")
    price = st.price[bk]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["city", "local_date", "bracket", "method", "decision_slot", "entry_price_cents", "won"])
        for i in d.tolist():
            w.writerow([
                col["city"][i], col["local_date"][i], col["bracket"][i], col["method"][i],
                bucket if bucket >= 0 else "first_tick", f"{price[i]:.2f}", int(st.won[i] > 0.5),
            ])
    stats = cluster_one(d, col, price)
    summary = (
        "n=0" if stats is None else
        f"n={stats['n']} city_days={stats['days']} win={stats['win']:.4f} "
        f"avg_price={stats['avg_price']:.2f} avg_edge={stats['avg_edge']:.2f} t={stats['t']:.2f}"
    )
    with open(os.path.join(args.out, "dump_index.txt"), "a", encoding="utf-8") as fh:
        fh.write(f"{tag}\t{args.dump_rule}\tmax_date={args.max_date or 'none'}\t{summary}\n")
    print(f"rule: {args.dump_rule}")
    print(f"max date: {args.max_date or 'none'}   file: {path}")
    print(summary)


def parse_args():
    p = argparse.ArgumentParser(description="Search bet_features dimension combinations.")
    p.add_argument("--max-dims", type=int, default=3)
    p.add_argument("--city", help="restrict to one city")
    p.add_argument("--ignore-gate", action="store_true")
    p.add_argument("--ignore-cap", action="store_true")
    p.add_argument("--include-final", action="store_true")
    p.add_argument("--include-region", action="store_true")
    p.add_argument("--all-dates", action="store_true")
    p.add_argument("--out", default="combo_out")
    p.add_argument("--workers", type=int, default=0,
                   help="worker processes (0 = every core, 1 = no multiprocessing)")
    p.add_argument("--screen-top", type=int, default=5000,
                   help="fully score only the best N combos per class (hour / no-hour) "
                        "by a cheap train-profit screen; 0 scores every combo (slow, exact)")
    p.add_argument("--min-bets", type=int, default=None,
                   help="minimum train bets per combo (default 30; --fast uses 100)")
    p.add_argument("--price-widths", default=None,
                   help="first-tick price bucket widths, comma separated "
                        "(default 10,20,25,50; --fast uses 20,50)")
    p.add_argument("--no-mixed-hours", action="store_true",
                   help="hour dimensions in one combo must all use the same bucket")
    p.add_argument("--fast", action="store_true",
                   help="shortcut for --min-bets 100 --price-widths 20,50 --no-mixed-hours")
    p.add_argument("--dump-rule",
                   help='score ONE rule string and write its bets, for example '
                        '"first_tick_hour=8AM | lead_margin:7=moderate"')
    p.add_argument("--max-date",
                   help="use only city-days on or before this date (YYYY-MM-DD)")
    args = p.parse_args()
    if args.min_bets is None:
        args.min_bets = 100 if args.fast else 30
    if args.price_widths is None:
        args.price_widths = "20,50" if args.fast else ",".join(str(w) for w in PRICE_WIDTHS)
    args.price_widths = tuple(int(w) for w in str(args.price_widths).split(",") if w.strip())
    if args.fast:
        args.no_mixed_hours = True
    if args.min_bets < 1 or not args.price_widths or args.max_dims < 1 or args.screen_top < 0:
        p.error("need --min-bets >= 1, at least one price width, --max-dims >= 1, --screen-top >= 0")
    return args


def main():
    args = parse_args()
    if args.include_region:
        sys.exit(
            "The region dimension needs the city→region map from cities-config, "
            "which is not in this repo. Omit --include-region."
        )
    if args.city:
        args.city = args.city.strip().lower()
    db = connect()
    print("Loading bet_features...")
    with timed("load bet_features"):
        docs = load_frame(db, args.city, args.max_date)
    db.client.close()  # nothing below needs Mongo; keeps forked workers clean
    with timed("build columns"):
        col0 = build_columns(docs)
    del docs
    dates = sorted(set(col0["local_date"]))
    n = col0["n"]
    n_dates = len(dates)
    if args.all_dates:
        period = np.zeros(n, dtype=np.int8)
        val_cut = fin_cut = None
    else:
        i_val = min(n_dates - 1, int(n_dates * 0.6))
        i_fin = min(n_dates - 1, int(n_dates * 0.8))
        if i_fin <= i_val:
            i_fin = min(n_dates - 1, i_val + 1)
        val_cut = dates[i_val]
        fin_cut = dates[i_fin]
        ld = col0["local_date"]
        period = np.where(ld < val_cut, 0, np.where(ld < fin_cut, 1, 2)).astype(np.int8)
    # Sort rows by (period, city-day, bracket, method): the layout the fast path relies on.
    order = np.lexsort((col0["method_code"], col0["bracket_id"], col0["city_date_id"], period))
    with timed("build families + reorder"):
        families = build_families(col0, args.include_final, args.price_widths)  # original row order
        col = reorder_columns(col0, order)
        families = reorder_families(families, order)
    period = period[order]
    del col0
    if args.dump_rule:
        dump_rule(col, families, args)
        return
    if args.all_dates:
        run_all_dates(col, families, dates, args)
        return
    train = period == 0
    validate = period == 1
    final = period == 2
    train_dates = [d for d in dates if d < val_cut]
    val_dates = [d for d in dates if val_cut <= d < fin_cut]
    fin_dates = [d for d in dates if d >= fin_cut]
    print(f"Bets {col['n']:,}  dates {dates[0]} → {dates[-1]}")
    print(f"Train starts {train_dates[0]}, validate starts {val_cut}, final starts {fin_cut}")
    print(
        f"Train bets {int(train.sum()):,}  validate bets {int(validate.sum()):,}  "
        f"final bets {int(final.sum()):,}"
    )
    with timed("baseline audit"):
        dataset_drops(col)
        baseline_audit(col, train)
    _announce(args, sum(len(f) for f in families), col)
    n_train = int(train.sum())
    n_tv = n_train + int(validate.sum())
    rows = search_fast(col, families, args, n_train, n_tv, "profit")
    with timed("report"):
        report(rows, col, train, validate, final, (train_dates, val_dates, fin_dates), args)


if __name__ == "__main__":
    _t0 = time.perf_counter()
    try:
        main()
    finally:
        print(f"\nTotal runtime: {fmt_elapsed(time.perf_counter() - _t0)}")