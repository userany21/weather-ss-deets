"""
Weather-market CSV analyzer (wethr.net / Polymarket ensemble-tracker pipeline).

Usage:
    python3 weather_market_analysis.py path/to/file.csv

Parses the `history` column ("29.6C (11:00am, 0c) -> 30.4C (12:00pm, 38c)")
into ordered ticks per city/date and reports:
  - overall coverage / data-quality stats (nulls, mixed units, row counts)
  - price distribution stats (edge-zone %, extremes %)
  - per-city volatility ranking
  - temp-move vs price-move relationship (does price lead or lag temp?)
  - edge-zone (10-70c) momentum: what happens to price on the NEXT tick
    after it's sitting in the edge zone, split by up-flag vs not
"""
import csv, re, sys, statistics as stats
from collections import defaultdict

TICK_RE = re.compile(r'(null|-?\d+\.?\d*)([CF])\s*\(([^,)]+)(?:,\s*(\d+)\xa2(\xe2\x86\x91|\u2191)?)?\)')
# more robust: just match degree-cent-arrow generically
TICK_RE = re.compile(r'(null|-?\d+\.?\d*)([CF])\s*\(([^,)]+)(?:,\s*(\d+)¢(↑)?)?\)')

def f_to_c(f):
    return (f - 32) * 5.0 / 9.0

def load_rows(path):
    with open(path, encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))

def infer_canonical_units(rows):
    """
    Per-tick and per-row unit labels are unreliable (a handful of ticks get
    mistagged C<->F even though the real-world value clearly isn't plausible
    in that unit -- e.g. Tokyo showing '33.4F' right next to '33.4C' at the
    identical timestamp). The TRUE unit is a property of the city (US cities
    report F, everywhere else reports C) and barely ever actually changes.
    So: take a majority vote of every tick's raw unit letter, per city, and
    use THAT as the one true unit for every tick belonging to that city --
    overriding both the per-tick letter and the row-level `unit` column.
    """
    from collections import Counter
    votes = defaultdict(Counter)
    for r in rows:
        for m in TICK_RE.finditer(r['history']):
            _, unit, _, _, _ = m.groups()
            votes[r['city']].append(unit) if False else votes[r['city']].update([unit])
    return {city: counter.most_common(1)[0][0] for city, counter in votes.items()}

def parse_ticks(rows):
    """Return list of rows, each with an ordered list of tick dicts (temp normalized to C)."""
    canonical = infer_canonical_units(rows)
    parsed = []
    corrections = 0
    for r in rows:
        true_unit = canonical[r['city']]
        ticks = []
        for m in TICK_RE.finditer(r['history']):
            temp_raw, tagged_unit, time_str, price, flag = m.groups()
            temp = None if temp_raw == 'null' else float(temp_raw)
            if tagged_unit != true_unit:
                corrections += 1
            temp_c = None if temp is None else (temp if true_unit == 'C' else f_to_c(temp))
            ticks.append({
                'time': time_str.strip(),
                'temp_c': temp_c,
                'unit': true_unit,          # corrected unit, not the raw tag
                'tagged_unit': tagged_unit, # what the source actually said
                'price': int(price) if price else None,
                'flagged': bool(flag),
            })
        parsed.append({'city': r['city'], 'date': r['date'], 'unit_declared': r['unit'], 'ticks': ticks})
    print(f"[unit-fix] {corrections} of {sum(len(row['ticks']) for row in parsed)} ticks had a "
          f"mislabeled C/F tag, corrected using each city's canonical unit.\n")
    return parsed

def coverage_report(parsed):
    all_ticks = [t for row in parsed for t in row['ticks']]
    n = len(all_ticks)
    nulls = sum(1 for t in all_ticks if t['temp_c'] is None)
    priced = [t for t in all_ticks if t['price'] is not None]
    prices = [t['price'] for t in priced]
    edge = [p for p in prices if 10 <= p <= 70]
    extreme = [p for p in prices if p <= 5 or p >= 95]
    print(f"Rows: {len(parsed)}  |  Ticks: {n}")
    print(f"Null temps: {nulls} ({100*nulls/n:.1f}%)")
    print(f"Priced ticks: {len(priced)} ({100*len(priced)/n:.1f}%)")
    print(f"Price mean/median/stdev: {stats.mean(prices):.1f} / {stats.median(prices)} / {stats.pstdev(prices):.1f}")
    print(f"Edge zone (10-70c): {len(edge)} ({100*len(edge)/len(prices):.1f}%)")
    print(f"Near-certain (<=5 or >=95): {len(extreme)} ({100*len(extreme)/len(prices):.1f}%)")

    mistagged_rows = [r for r in parsed if any(t['tagged_unit'] != t['unit'] for t in r['ticks'])]
    print(f"Rows containing a mistagged C/F tick (now corrected): {len(mistagged_rows)} ({100*len(mistagged_rows)/len(parsed):.1f}%)")

def city_volatility(parsed):
    by_city = defaultdict(list)
    for row in parsed:
        for t in row['ticks']:
            by_city[row['city']].append(t)
    out = []
    for city, ticks in by_city.items():
        prices = [t['price'] for t in ticks if t['price'] is not None]
        if not prices:
            continue
        out.append((city, len(ticks), max(prices)-min(prices), stats.mean(prices)))
    out.sort(key=lambda x: -x[2])
    print(f"\n{'city':15}{'ticks':>7}{'range':>8}{'avgP':>8}")
    for city, n, rng, avg in out:
        print(f"{city:15}{n:>7}{rng:>8}{avg:>8.1f}")
    return out

def temp_price_lead_lag(parsed):
    """
    For consecutive ticks (t, t+1) with valid temp and price on both:
      temp_dir  = sign(temp[t+1] - temp[t])
      price_dir = sign(price[t+1] - price[t])
    Compare same-step agreement (does price move same direction as temp,
    tick to tick) -- a crude proxy for whether the market is tracking
    the live temp signal at all.
    """
    same, opp, flat = 0, 0, 0
    pairs = 0
    for row in parsed:
        ticks = [t for t in row['ticks'] if t['temp_c'] is not None and t['price'] is not None]
        for a, b in zip(ticks, ticks[1:]):
            dt = b['temp_c'] - a['temp_c']
            dp = b['price'] - a['price']
            if dt == 0 or dp == 0:
                flat += 1
                continue
            pairs += 1
            if (dt > 0) == (dp > 0):
                same += 1
            else:
                opp += 1
    print(f"\nConsecutive-tick temp/price direction check ({pairs} directional pairs, {flat} flat):")
    if pairs:
        print(f"  Same direction (price tracks temp): {same} ({100*same/pairs:.1f}%)")
        print(f"  Opposite direction: {opp} ({100*opp/pairs:.1f}%)")

def edge_zone_momentum(parsed):
    """
    When a tick sits in the 10-70c edge zone, what does the price do on the
    VERY NEXT tick? Split by whether that edge-zone tick was flagged (up-arrow)
    or not. This approximates: 'once we're in Alan's known edge range, does an
    existing up-flag actually predict further movement, or is it noise?'
    """
    moves_flagged, moves_unflagged = [], []
    for row in parsed:
        ticks = [t for t in row['ticks'] if t['price'] is not None]
        for a, b in zip(ticks, ticks[1:]):
            if 10 <= a['price'] <= 70:
                delta = b['price'] - a['price']
                (moves_flagged if a['flagged'] else moves_unflagged).append(delta)
    def summarize(label, moves):
        if not moves:
            print(f"  {label}: no samples")
            return
        pos = sum(1 for m in moves if m > 0)
        print(f"  {label}: n={len(moves)}  avg next-tick move={stats.mean(moves):+.1f}c  "
              f"median={stats.median(moves):+.1f}c  moved up {100*pos/len(moves):.0f}% of the time")
    print("\nEdge-zone (10-70c) next-tick momentum:")
    summarize("Flagged (already marked up)", moves_flagged)
    summarize("Unflagged", moves_unflagged)

def edge_zone_momentum_by_city(parsed):
    """Same as edge_zone_momentum but broken out per city."""
    by_city = defaultdict(list)
    for row in parsed:
        ticks = [t for t in row['ticks'] if t['price'] is not None]
        for a, b in zip(ticks, ticks[1:]):
            if 10 <= a['price'] <= 70:
                by_city[row['city']].append(b['price'] - a['price'])

    print("\nEdge-zone next-tick momentum by city (min 5 samples):")
    print(f"{'city':15}{'n':>5}{'avg move':>10}{'median':>9}{'%up':>6}")
    rows_out = []
    for city, moves in by_city.items():
        if len(moves) < 5:
            continue
        pos = 100 * sum(1 for m in moves if m > 0) / len(moves)
        rows_out.append((city, len(moves), stats.mean(moves), stats.median(moves), pos))
    rows_out.sort(key=lambda x: -x[2])
    for city, n, avg, med, pos in rows_out:
        print(f"{city:15}{n:>5}{avg:>+9.1f}c{med:>+8.1f}c{pos:>5.0f}%")

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else '/mnt/user-data/uploads/8-26_to_8-31.csv'
    rows = load_rows(path)
    parsed = parse_ticks(rows)
    coverage_report(parsed)
    city_volatility(parsed)
    temp_price_lead_lag(parsed)
    edge_zone_momentum(parsed)
    edge_zone_momentum_by_city(parsed)

if __name__ == '__main__':
    main()