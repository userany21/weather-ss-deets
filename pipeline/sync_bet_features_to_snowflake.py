#!/usr/bin/env python3
"""
Sync MongoDB `bet_features` -> Snowflake.

Upserts on (city, local_date, bracket, method), the same key that
build_bet_features.py uses for its ReplaceOne. Each Mongo document lands whole
in a VARIANT column (DOC), so new builder fields show up without a schema change.

Incremental: reads MAX(COMPUTED_AT) from Snowflake and pulls only Mongo docs with
computed_at >= that value. It is >= (not >) because a builder pass stamps every
doc with the same computed_at and may still be writing when we read. The first
run against an empty table loads everything.

Assumes computed_at is a BSON Date.

    pip install pymongo "snowflake-connector-python[pandas]"

Env vars:
    MONGO_URI, MONGO_DB
    SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_WAREHOUSE, SNOWFLAKE_ROLE (optional)
    SNOWFLAKE_PRIVATE_KEY_FILE (+ SNOWFLAKE_PRIVATE_KEY_PASSPHRASE)  -- or --
    SNOWFLAKE_PASSWORD

Usage:
    python sync_bet_features_to_snowflake.py --full               # one-time backfill
    python sync_bet_features_to_snowflake.py                      # one incremental pass (cron)
    python sync_bet_features_to_snowflake.py --loop-seconds 900   # long-running loop (PM2)
"""
import argparse
import json
import logging
import math
import os
import time
from datetime import date, datetime
from decimal import Decimal

import pandas as pd
import snowflake.connector
from bson import ObjectId
from bson.decimal128 import Decimal128
from pymongo import MongoClient
from snowflake.connector.pandas_tools import write_pandas

KEY = ("city", "local_date", "bracket", "method")
STG = "BET_FEATURES_STG"
log = logging.getLogger("bf_sync")


def kstr(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return "" if v is None else str(v)


def clean(o):
    """Make a Mongo doc JSON-safe: NaN/Inf -> None, BSON types -> plain values."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, Decimal128):
        return float(o.to_decimal())
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, ObjectId):
        return str(o)
    return o


def sf_connect(args):
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


def flush(conn, target, docs):
    rows = {}  # dedupe on key so MERGE never sees two source rows for one target row
    for d in docs:
        d.pop("_id", None)
        key = tuple(kstr(d.get(k)) for k in KEY)
        ca = d.get("computed_at")
        rows[key] = (*key, ca.isoformat() if isinstance(ca, datetime) else "",
                     json.dumps(clean(d)))
    df = pd.DataFrame(list(rows.values()),
                      columns=["CITY", "LOCAL_DATE", "BRACKET", "METHOD", "COMPUTED_AT", "DOC_JSON"])
    cur = conn.cursor()
    cur.execute(f"TRUNCATE TABLE {STG}")
    write_pandas(conn, df, STG, quote_identifiers=False)
    cur.execute(f"""
        MERGE INTO {target} t
        USING (SELECT CITY, LOCAL_DATE, BRACKET, METHOD,
                      TO_TIMESTAMP_NTZ(NULLIF(COMPUTED_AT, '')) AS COMPUTED_AT,
                      PARSE_JSON(DOC_JSON) AS DOC
               FROM {STG}) s
        ON  t.CITY = s.CITY AND t.LOCAL_DATE = s.LOCAL_DATE
        AND t.BRACKET = s.BRACKET AND t.METHOD = s.METHOD
        WHEN MATCHED THEN UPDATE SET t.COMPUTED_AT = s.COMPUTED_AT, t.DOC = s.DOC
        WHEN NOT MATCHED THEN INSERT (CITY, LOCAL_DATE, BRACKET, METHOD, COMPUTED_AT, DOC)
             VALUES (s.CITY, s.LOCAL_DATE, s.BRACKET, s.METHOD, s.COMPUTED_AT, s.DOC)
    """)
    return len(df)


def sync_once(coll, conn, target, full, chunk):
    cur = conn.cursor()
    cur.execute(f"""CREATE TABLE IF NOT EXISTS {target} (
        CITY VARCHAR, LOCAL_DATE VARCHAR, BRACKET VARCHAR, METHOD VARCHAR,
        COMPUTED_AT TIMESTAMP_NTZ, DOC VARIANT)""")
    cur.execute(f"""CREATE TEMPORARY TABLE IF NOT EXISTS {STG} (
        CITY VARCHAR, LOCAL_DATE VARCHAR, BRACKET VARCHAR, METHOD VARCHAR,
        COMPUTED_AT VARCHAR, DOC_JSON VARCHAR)""")

    wm = None if full else cur.execute(f"SELECT MAX(COMPUTED_AT) FROM {target}").fetchone()[0]
    query = {"computed_at": {"$gte": wm}} if wm else {}
    log.info("pulling from Mongo (watermark=%s)", wm)

    total, batch = 0, []
    for doc in coll.find(query, batch_size=5000):
        batch.append(doc)
        if len(batch) >= chunk:
            total += flush(conn, target, batch)
            batch = []
    if batch:
        total += flush(conn, target, batch)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mongo-db", default=os.environ.get("MONGO_DB"))
    ap.add_argument("--collection", default="bet_features")
    ap.add_argument("--database", default="WEATHER")
    ap.add_argument("--schema", default="PUBLIC")
    ap.add_argument("--table", default="BET_FEATURES_LIVE")
    ap.add_argument("--full", action="store_true", help="ignore watermark, reload everything")
    ap.add_argument("--loop-seconds", type=int, default=0, help="0 = run once and exit")
    ap.add_argument("--chunk", type=int, default=20000)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    coll = MongoClient(os.environ["MONGO_URI"])[args.mongo_db][args.collection]
    target = f"{args.database}.{args.schema}.{args.table}"

    while True:
        try:
            conn = sf_connect(args)  # fresh connection per pass so the warehouse can auto-suspend
            try:
                n = sync_once(coll, conn, target, args.full, args.chunk)
            finally:
                conn.close()
            log.info("upserted %d rows into %s", n, target)
        except Exception:
            if not args.loop_seconds:
                raise
            log.exception("pass failed; retrying next interval")
        if not args.loop_seconds:
            break
        args.full = False
        time.sleep(args.loop_seconds)


if __name__ == "__main__":
    main()