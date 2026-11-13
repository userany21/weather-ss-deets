#!/usr/bin/env python3
"""
Refresh WEATHER.PUBLIC.DIM2 .. DIM10 from fresh bet_features data.

What one run does
  1. Asks Mongo for the newest resolved local_date. If that is older than
     --max-stale-days the builder is stuck, so it stops before burning hours.
     Otherwise every search is pinned to one cutoff date (newest resolved day
     minus --lag-days). The searches take hours, so without a pin DIM2 and DIM10
     could be computed on different data.
  2. Runs combo_search_fast.py once per --max-dims value in --all-dates mode.
     Each run writes <out>/bet_combos_all_dates_dim{N}.csv.
  3. Only if EVERY search succeeded: loads each CSV into a staging table
     (DIM{N}_STG), compares row counts with the live table, then replaces all
     the real tables in ONE transaction. A failure anywhere leaves every DIM
     table, and so ALL_DIMS, exactly as it was.
  4. Writes one row per DIM to WEATHER.PUBLIC.DIM_REFRESH_LOG (rows before and
     after, data_through, when) so analysts can see how fresh the numbers are.

Put this next to combo_search_fast.py (the weather-stats repo) and run it there.
The search flags must match how the existing DIM tables were built. The log
prints old -> new row counts per table, so a mismatch shows up right away:

    python refresh_dims.py
    python refresh_dims.py --search-args "--workers 2"

Try the upload path alone, using CSVs you already have:

    python refresh_dims.py --dims 3 --skip-search

Env vars (the same .env the search script already reads):
    MONGO_URI, DB_NAME (optional, default "weather")
    SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_WAREHOUSE, SNOWFLAKE_ROLE (optional)
    SNOWFLAKE_PRIVATE_KEY_FILE (+ SNOWFLAKE_PRIVATE_KEY_PASSPHRASE) or SNOWFLAKE_PASSWORD

    pip install python-dotenv pymongo snowflake-connector-python
"""
import argparse
import csv
import os
import shlex
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

# Column order of bet_combos_all_dates_dim{N}.csv (the DIM tables rename "by" to group_by).
EXPECTED = [
    "city", "method", "base", "by", "bucket", "has_hour", "parent",
    "n", "city_days", "win", "avg_price", "avg_edge", "se", "edge_lower",
    "total_profit", "t", "edge_over_parent", "n_nocap", "edge_nocap",
]
LOCK = Path(__file__).with_name("refresh_dims.lock")


def parse_dims(text):
    if "-" in text:
        lo, hi = text.split("-")
        return list(range(int(lo), int(hi) + 1))
    return [int(x) for x in text.split(",")]


def arg_value(tokens, flag):
    """Value of --flag in a token list, for both '--flag v' and '--flag=v'."""
    for i, tok in enumerate(tokens):
        if tok == flag and i + 1 < len(tokens):
            return tokens[i + 1]
        if tok.startswith(flag + "="):
            return tok.split("=", 1)[1]
    return None


def pick_cutoff(lag_days, max_stale_days):
    """(cutoff, newest): newest resolved local_date in Mongo, and that minus lag_days."""
    from pymongo import MongoClient  # the search script needs it too

    uri = os.environ.get("MONGO_URI")
    if not uri:
        sys.exit("Set MONGO_URI (the search script reads the same variable).")
    client = MongoClient(uri, serverSelectionTimeoutMS=20000)
    try:
        coll = client[os.environ.get("DB_NAME", "weather")]["bet_features"]
        doc = coll.find_one(
            {"resolved": True, "won": {"$ne": None}}, {"local_date": 1}, sort=[("local_date", -1)]
        )
    finally:
        client.close()
    if not doc:
        sys.exit("no resolved rows in bet_features: wrong DB_NAME, or the builder never ran")
    newest = date.fromisoformat(str(doc["local_date"]))
    age = (datetime.now(timezone.utc).date() - newest).days
    if age > max_stale_days:
        sys.exit(
            f"newest resolved day in bet_features is {newest} ({age} days old, limit {max_stale_days}). "
            "The builder or the winner resolution looks stuck; fix that first, or raise --max-stale-days."
        )
    return (newest - timedelta(days=lag_days)).isoformat(), newest.isoformat()


def run_search(script, n, out, extra):
    cmd = [sys.executable, str(script), "--all-dates", "--max-dims", str(n), "--out", str(out), *extra]
    print("running:", " ".join(cmd), flush=True)
    t0 = time.time()
    subprocess.run(cmd, check=True, cwd=script.parent)
    print(f"  dim{n} search finished in {(time.time() - t0) / 60:.1f} min", flush=True)


def check_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        header = next(csv.reader(fh), [])
        rows = sum(1 for _ in fh)
    if header != EXPECTED:
        sys.exit(f"{path.name}: unexpected columns.\n  got      {header}\n  expected {EXPECTED}")
    if rows == 0:
        sys.exit(f"{path.name} has no data rows; refusing to overwrite the table with nothing.")
    return rows


def connect(args):
    import snowflake.connector

    kw = dict(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        warehouse=os.environ["SNOWFLAKE_WAREHOUSE"],
        database=args.database,
        schema=args.schema,
    )
    if os.environ.get("SNOWFLAKE_ROLE"):
        kw["role"] = os.environ["SNOWFLAKE_ROLE"]
    if os.environ.get("SNOWFLAKE_PRIVATE_KEY_FILE"):
        kw["private_key_file"] = os.environ["SNOWFLAKE_PRIVATE_KEY_FILE"]
        if os.environ.get("SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"):
            kw["private_key_file_pwd"] = os.environ["SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"]
    else:
        kw["password"] = os.environ["SNOWFLAKE_PASSWORD"]
    return snowflake.connector.connect(**kw)


def stage_table(conn, db, schema, n, path):
    """Load one CSV into DIM{n}_STG. Touches nothing live. Returns (rows_before, rows_after)."""
    cur = conn.cursor()
    target = f"{db}.{schema}.DIM{n}"
    stage = f"{db}.{schema}.DIM{n}_STG"
    before = cur.execute(f"SELECT COUNT(*) FROM {target}").fetchone()[0]
    cur.execute(f"CREATE OR REPLACE TRANSIENT TABLE {stage} LIKE {target}")
    cur.execute(f"PUT 'file://{path.as_posix()}' @~/dims_refresh/ AUTO_COMPRESS=TRUE OVERWRITE=TRUE")
    cur.execute(f"""
        COPY INTO {stage}
        FROM @~/dims_refresh/
        FILES = ('{path.name}.gz')
        FILE_FORMAT = (TYPE = CSV SKIP_HEADER = 1 FIELD_OPTIONALLY_ENCLOSED_BY = '"'
                       NULL_IF = ('', 'nan', 'NaN', 'inf', '-inf') EMPTY_FIELD_AS_NULL = TRUE)
        ON_ERROR = ABORT_STATEMENT
        PURGE = TRUE
    """)
    after = cur.execute(f"SELECT COUNT(*) FROM {stage}").fetchone()[0]
    if after == 0:
        raise RuntimeError(f"{stage} is empty after COPY; leaving {target} untouched")
    return before, after


def swap_all(conn, db, schema, counts, data_through, search_args):
    """Replace every live DIM table from its staging table in one transaction, and log the run."""
    cur = conn.cursor()
    log = f"{db}.{schema}.DIM_REFRESH_LOG"
    # DDL commits on its own, so it goes before BEGIN.
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS {log} (
            REFRESHED_AT_UTC TIMESTAMP_NTZ, DIM NUMBER, ROWS_BEFORE NUMBER, ROWS_AFTER NUMBER,
            DATA_THROUGH DATE, SEARCH_ARGS VARCHAR)
    """)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    cur.execute("BEGIN")
    try:
        for n, (before, after) in counts.items():
            cur.execute(f"INSERT OVERWRITE INTO {db}.{schema}.DIM{n} SELECT * FROM {db}.{schema}.DIM{n}_STG")
            cur.execute(
                f"INSERT INTO {log} VALUES (%s, %s, %s, %s, %s, %s)",
                (stamp, n, before, after, data_through, search_args),
            )
        cur.execute("COMMIT")
    except Exception:
        cur.execute("ROLLBACK")
        raise


def drop_stages(conn, db, schema, dims):
    cur = conn.cursor()
    for n in dims:
        try:
            cur.execute(f"DROP TABLE IF EXISTS {db}.{schema}.DIM{n}_STG")
        except Exception as exc:  # cleanup only; never mask the real error
            print(f"  could not drop DIM{n}_STG: {exc}", flush=True)


def main():
    load_dotenv()
    if hasattr(os, "nice"):  # Linux: lowest priority for this process and the search it launches
        os.nice(19)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--search-script", default="combo_search_fast.py", help="path to the combo search script")
    ap.add_argument("--search-args", default="", help='extra flags for every search, e.g. "--workers 2"')
    ap.add_argument("--dims", default="2-10", help="e.g. 2-10 or 3,5")
    ap.add_argument("--out", default="combo_out")
    ap.add_argument("--database", default="WEATHER")
    ap.add_argument("--schema", default="PUBLIC")
    ap.add_argument("--lag-days", type=int, default=1,
                    help="stay this many days behind the newest resolved day, so cities that resolve late are settled")
    ap.add_argument("--max-stale-days", type=int, default=3,
                    help="abort if the newest resolved day in Mongo is older than this")
    ap.add_argument("--min-ratio", type=float, default=0.5,
                    help="abort the swap if any table would shrink below this fraction of its current rows")
    ap.add_argument("--force", action="store_true", help="skip the --min-ratio check")
    ap.add_argument("--lock-hours", type=float, default=12,
                    help="a lock file older than this is treated as left over from a crash")
    ap.add_argument("--skip-search", action="store_true", help="upload existing CSVs only")
    ap.add_argument("--no-upload", action="store_true", help="run the searches, skip Snowflake")
    args = ap.parse_args()

    if LOCK.exists() and time.time() - LOCK.stat().st_mtime < args.lock_hours * 3600:
        sys.exit(f"another refresh looks active ({LOCK.name} is under {args.lock_hours:g}h old); exiting")
    LOCK.write_text(str(os.getpid()))
    t_start = time.time()
    conn = None
    dims = []
    try:
        dims = parse_dims(args.dims)
        out = Path(args.out).resolve()
        out.mkdir(parents=True, exist_ok=True)

        data_through = None
        extra = shlex.split(args.search_args)
        if not args.skip_search:
            script = Path(args.search_script).resolve()
            if not script.exists():
                sys.exit(f"search script not found: {script} (use --search-script)")
            data_through = arg_value(extra, "--max-date")
            if data_through is None:
                data_through, newest = pick_cutoff(args.lag_days, args.max_stale_days)
                extra += ["--max-date", data_through]
                print(f"newest resolved day {newest}; all searches pinned to --max-date {data_through}", flush=True)
            for n in dims:  # any failure raises here, before anything is uploaded
                run_search(script, n, out, extra)

        files = {n: out / f"bet_combos_all_dates_dim{n}.csv" for n in dims}
        for n, p in files.items():
            if not p.exists():
                sys.exit(f"missing {p}")
            print(f"{p.name}: {check_csv(p):,} rows", flush=True)
        if args.no_upload:
            return

        conn = connect(args)
        counts = {}
        for n, p in files.items():  # stage everything first; nothing live changes yet
            counts[n] = stage_table(conn, args.database, args.schema, n, p)
            before, after = counts[n]
            print(f"DIM{n}: staged {after:,} rows (live table has {before:,})", flush=True)

        if not args.force:
            shrunk = [f"DIM{n}: {b:,} -> {a:,}" for n, (b, a) in counts.items() if b and a < b * args.min_ratio]
            if shrunk:
                raise RuntimeError(
                    "refusing to swap, these would shrink below "
                    f"{args.min_ratio:g}x of the current rows: {'; '.join(shrunk)}. "
                    "Check the search flags match how the tables were built, or use --force."
                )

        swap_all(conn, args.database, args.schema, counts, data_through, args.search_args)
        for n, (before, after) in counts.items():
            print(f"DIM{n}: {before:,} -> {after:,} rows", flush=True)
        print(f"done in {(time.time() - t_start) / 60:.1f} min, data through {data_through or 'unknown'}")
    finally:
        if conn is not None:
            drop_stages(conn, args.database, args.schema, dims)
            conn.close()
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    main()