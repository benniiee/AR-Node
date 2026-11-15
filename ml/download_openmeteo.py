"""Download Open-Meteo *historical forecast* data for the campus point.

Free, no API key, CC BY 4.0 (keep the "Weather data by Open-Meteo.com"
attribution; the free tier is non-commercial). Docs:
https://open-meteo.com/en/docs/historical-forecast-api

What you get (Zamboanga City campus point, local time Asia/Manila):
  data/openmeteo_minutely15.csv  15-minute precipitation, temperature, humidity, ...
  data/openmeteo_hourly.csv      hourly pressure, cloud cover, rain probability, precipitation

Notes
- Outside Central Europe / North America the 15-minute values are interpolated
  from hourly model output, so they are NOT true 15-minute measurements.
- The archive is stitched from the first hours of each model run, so offline
  scores are slightly optimistic compared with real live forecasts. Shadow
  mode on the live server is the real test.
- Raw JSON per chunk is cached in data/raw/, so a re-run resumes where it stopped.

Usage:  python download_openmeteo.py --start 2022-01-01
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

from common import (DATA, HOURLY_CSV, HOURLY_VARS, LAT, LON, M15_CSV, MINUTELY_VARS, RAW, TZ)

URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
CHUNK_DAYS = 30


def fetch(params: dict, minutely: list[str], hourly: list[str]) -> dict:
    """GET with 429 back-off. On HTTP 400 drop any variable the API names and retry once."""
    for attempt in range(6):
        q = dict(params, minutely_15=",".join(minutely), hourly=",".join(hourly))
        r = requests.get(URL, params=q, timeout=60)
        if r.status_code == 429:
            wait = 65 * (attempt + 1)
            print(f"  rate limited, waiting {wait}s ...", flush=True)
            time.sleep(wait)
            continue
        if r.status_code == 400:
            reason = r.json().get("reason", r.text)
            bad = [v for v in minutely + hourly if re.search(rf"\b{re.escape(v)}\b", reason)]
            if bad and attempt < 2:
                print(f"  API rejected {bad}: {reason}\n  retrying without them", flush=True)
                minutely = [v for v in minutely if v not in bad]
                hourly = [v for v in hourly if v not in bad]
                continue
            sys.exit(f"Open-Meteo error: {reason}")
        r.raise_for_status()
        return r.json()
    sys.exit("Gave up after repeated rate limiting. Try again later (free tier: ~5,000 calls/hour, 10,000/day).")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2022-01-01", help="first day (historical forecast archive starts around 2022)")
    ap.add_argument("--end", default=str(date.today() - timedelta(days=2)), help="last day, default = 2 days ago")
    ap.add_argument("--lat", type=float, default=LAT)
    ap.add_argument("--lon", type=float, default=LON)
    ap.add_argument("--sleep", type=float, default=0.5, help="pause between requests (seconds)")
    a = ap.parse_args()

    RAW.mkdir(parents=True, exist_ok=True)
    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    m_frames, h_frames = [], []
    day = start
    while day <= end:
        stop = min(day + timedelta(days=CHUNK_DAYS - 1), end)
        cache = RAW / f"om_{a.lat:.4f}_{a.lon:.4f}_{day}_{stop}.json"
        if cache.exists():
            data = json.loads(cache.read_text())
        else:
            print(f"fetching {day} -> {stop}", flush=True)
            data = fetch(
                {"latitude": a.lat, "longitude": a.lon, "start_date": str(day),
                 "end_date": str(stop), "timezone": TZ},
                list(MINUTELY_VARS), list(HOURLY_VARS),
            )
            cache.write_text(json.dumps(data))
            time.sleep(a.sleep)
        if "minutely_15" in data:
            m_frames.append(pd.DataFrame(data["minutely_15"]))
        if "hourly" in data:
            h_frames.append(pd.DataFrame(data["hourly"]))
        day = stop + timedelta(days=1)

    if not m_frames or not h_frames:
        sys.exit("No data returned. Check the date range and your internet connection.")
    DATA.mkdir(exist_ok=True)
    m = pd.concat(m_frames).drop_duplicates("time").sort_values("time")
    h = pd.concat(h_frames).drop_duplicates("time").sort_values("time")
    m.to_csv(M15_CSV, index=False)
    h.to_csv(HOURLY_CSV, index=False)
    print(f"\nwrote {M15_CSV} ({len(m):,} rows) and {HOURLY_CSV} ({len(h):,} rows)")
    print("Missing share per column (high = variable unavailable for this location):")
    print(pd.concat([m.drop(columns="time").isna().mean(), h.drop(columns="time").isna().mean()]).round(3).to_string())
    print("\nData: Open-Meteo.com (CC BY 4.0)")


if __name__ == "__main__":
    main()
