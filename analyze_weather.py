#!/usr/bin/env python3
"""
analyze_weather.py

Turns the raw tick documents in weather.high-temp into actual charts.
This is the piece that goes AFTER the database query — Mongo's aggregation
is doing the "GROUP BY"-equivalent work of collapsing thousands of ticks
down into the handful of numbers each chart actually needs; matplotlib is
what turns those numbers into a picture.

Usage:
    pip install pymongo pandas matplotlib python-dotenv

    # Success rate per city (bar chart + printed table)
    python3 analyze_weather.py summary

    # Temp + price curves for one specific city-day
    python3 analyze_weather.py day "los angeles" 2026-09-02

Reads MONGO_URI from a .env file, same as the other scripts in this repo.
Charts are saved as PNG files in the current directory.
"""

import os
import sys
from datetime import datetime

import pandas as pd
import matplotlib
matplotlib.use('Agg')  # no display needed on the droplet — just save files
import matplotlib.pyplot as plt
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()


def get_collection():
    uri = os.environ.get('MONGO_URI')
    if not uri:
        print('Missing MONGO_URI in environment (.env)')
        sys.exit(1)
    client = MongoClient(uri)
    return client['weather']['high-temp']


def command_summary(collection):
    """
    Success rate per city: for every RESOLVED day, take the last tick before
    market close and check whether that forecast landed inside the winning
    bracket. This is the "GROUP BY city, compute a rate" step — the Mongo
    aggregation pipeline below is doing exactly that.
    """
    pipeline = [
        {'$match': {'winning_bracket': {'$ne': None}}},
        {'$sort': {'captured_at': 1}},
        {'$group': {
            '_id': {'city': '$city', 'local_date': '$local_date'},
            'last_weighted_avg': {'$last': '$weighted_avg'},
            'winning_low': {'$last': '$winning_bracket_low'},
            'winning_high': {'$last': '$winning_bracket_high'},
            'winning_bracket': {'$last': '$winning_bracket'},
        }},
    ]
    rows = list(collection.aggregate(pipeline))
    if not rows:
        print('No resolved days found yet (winning_bracket not set on anything).')
        return

    df = pd.DataFrame([{
        'city': r['_id']['city'],
        'local_date': r['_id']['local_date'],
        'last_weighted_avg': r['last_weighted_avg'],
        'winning_low': r['winning_low'],
        'winning_high': r['winning_high'],
        'winning_bracket': r['winning_bracket'],
    } for r in rows])

    df['hit'] = (df['last_weighted_avg'] >= df['winning_low']) & \
                (df['last_weighted_avg'] <= df['winning_high'])

    per_city = df.groupby('city').agg(
        days=('hit', 'count'),
        hits=('hit', 'sum'),
    )
    per_city['success_rate'] = (per_city['hits'] / per_city['days'] * 100).round(1)
    per_city = per_city.sort_values('success_rate', ascending=False)

    print(per_city)
    print(f"\nOverall: {df['hit'].sum()}/{len(df)} days "
          f"({df['hit'].mean() * 100:.1f}%)")

    fig, ax = plt.subplots(figsize=(10, 6))
    per_city['success_rate'].plot(kind='bar', ax=ax, color='#4a90d9')
    ax.set_ylabel('Success rate (%)')
    ax.set_xlabel('')
    ax.set_title('Forecast success rate by city (last tick vs. winning bracket)')
    ax.set_ylim(0, 100)
    plt.xticks(rotation=45, ha='right')
    plt.tight_layout()
    plt.savefig('success_rate_by_city.png', dpi=150)
    print('\nSaved success_rate_by_city.png')


def command_day(collection, city, local_date):
    """
    Pulls every tick for one city-day and plots two curves:
    temp-vs-time and price-vs-time, with the winning bracket shaded in
    if that day has resolved.
    """
    docs = list(collection.find(
        {'city': city, 'local_date': local_date}
    ).sort('captured_at', 1))

    if not docs:
        print(f'No documents found for {city} on {local_date}.')
        return

    df = pd.DataFrame(docs)
    df['captured_at'] = pd.to_datetime(df['captured_at'])

    winning_low = df['winning_bracket_low'].dropna().iloc[-1] if df['winning_bracket_low'].notna().any() else None
    winning_high = df['winning_bracket_high'].dropna().iloc[-1] if df['winning_bracket_high'].notna().any() else None
    winning_bracket = df['winning_bracket'].dropna().iloc[-1] if df['winning_bracket'].notna().any() else None

    # temp curve
    fig, ax = plt.subplots(figsize=(11, 5))
    ax.plot(df['captured_at'], df['weighted_avg'], marker='o', markersize=3, color='#d9534f')
    if winning_low is not None:
        ax.axhspan(winning_low, winning_high, color='#5cb85c', alpha=0.2,
                    label=f'Winning bracket: {winning_bracket}')
        ax.legend()
    ax.set_ylabel(f"Weighted avg temp ({df['unit'].iloc[0]})")
    ax.set_xlabel('Time')
    ax.set_title(f'{city.title()} — {local_date} — forecast temp over the day')
    plt.xticks(rotation=45, ha='right')
    plt.tight_layout()
    temp_filename = f"{city.replace(' ', '_')}_{local_date}_temp_curve.png"
    plt.savefig(temp_filename, dpi=150)
    print(f'Saved {temp_filename}')

    # price curve
    fig, ax = plt.subplots(figsize=(11, 5))
    ax.plot(df['captured_at'], df['yes_price'] * 100, marker='o', markersize=3, color='#4a90d9')
    ax.set_ylabel('Yes price (cents)')
    ax.set_xlabel('Time')
    ax.set_ylim(0, 100)
    ax.set_title(f'{city.title()} — {local_date} — market price over the day')
    plt.xticks(rotation=45, ha='right')
    plt.tight_layout()
    price_filename = f"{city.replace(' ', '_')}_{local_date}_price_curve.png"
    plt.savefig(price_filename, dpi=150)
    print(f'Saved {price_filename}')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    collection = get_collection()
    command = sys.argv[1]

    if command == 'summary':
        command_summary(collection)
    elif command == 'day':
        if len(sys.argv) != 4:
            print('Usage: python3 analyze_weather.py day "<city>" <YYYY-MM-DD>')
            sys.exit(1)
        command_day(collection, sys.argv[2], sys.argv[3])
    else:
        print(f'Unknown command: {command}')
        print(__doc__)
        sys.exit(1)


if __name__ == '__main__':
    main()