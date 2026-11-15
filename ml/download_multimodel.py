"""Download archived forecasts from SEVERAL weather models for the campus point.

The rain model uses how many models agree on rain, their average rain amount,
their average cloud cover and how many show a thunderstorm (common.py::
build_multimodel_features). A single model (Open-Meteo's best match, ECMWF IFS
here) often gets the timing of tropical showers wrong; agreement between models
is a steadier signal.

Same free Historical Forecast API as download_openmeteo.py (CC BY 4.0, keep the
"Weather data by Open-Meteo.com" attribution). Asking for many models counts as
several API calls per request, so chunks are cached in data/raw/ and a re-run
resumes where it stopped.

Writes data/openmeteo_multimodel_hourly.csv with columns
  time, precipitation_<model>, cloud_cover_<model>, weather_code_<model>  (local Asia/Manila time)

Usage:  python download_multimodel.py --start 2024-01-01
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

from common import DATA, LAT, LON, MM_MODELS, MM_VARS, MULTIMODEL_CSV, RAW, TZ

URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
CHUNK_DAYS = 30


def fetch(params: dict) -> dict:
    """GET with back-off on rate limiting."""
    for attempt in range(6):
        r = requests.get(URL, params=params, timeout=120)
        if r.status_code == 429:
            wait = 65 * (attempt + 1)
            print(f"  rate limited, waiting {wait}s ...", flush=True)
            time.sleep(wait)
            continue
        if r.status_code == 400:
            sys.exit(f"Open-Meteo error: {r.json().get('reason', r.text)}")
        r.raise_for_status()
        return r.json()
    sys.exit("Gave up after repeated rate limiting. Try again later (free tier: ~5,000 calls/hour, 10,000/day).")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2024-01-01", help="first day (most models are archived from 2024)")
    ap.add_argument("--end", default=str(date.today() - timedelta(days=2)), help="last day, default = 2 days ago")
    ap.add_argument("--sleep", type=float, default=1.0, help="pause between requests (seconds)")
    a = ap.parse_args()

    RAW.mkdir(parents=True, exist_ok=True)
    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    frames = []
    day = start
    while day <= end:
        stop = min(day + timedelta(days=CHUNK_DAYS - 1), end)
        cache = RAW / f"mm_{LAT:.4f}_{LON:.4f}_{day}_{stop}.json"
        if cache.exists():
            data = json.loads(cache.read_text())
        else:
            print(f"fetching {day} -> {stop}", flush=True)
            data = fetch({"latitude": LAT, "longitude": LON, "start_date": str(day), "end_date": str(stop),
                          "hourly": ",".join(MM_VARS), "models": ",".join(MM_MODELS), "timezone": TZ})
            cache.write_text(json.dumps(data))
            time.sleep(a.sleep)
        if "hourly" in data:
            frames.append(pd.DataFrame(data["hourly"]))
        day = stop + timedelta(days=1)

    if not frames:
        sys.exit("No data returned. Check the date range and your internet connection.")
    DATA.mkdir(exist_ok=True)
    h = pd.concat(frames).drop_duplicates("time").sort_values("time")
    h.to_csv(MULTIMODEL_CSV, index=False)
    print(f"\nwrote {MULTIMODEL_CSV} ({len(h):,} rows)")
    print("Share of hours with a value, per model (rain):")
    for m in MM_MODELS:
        col = f"precipitation_{m}"
        print(f"  {m:32s} {h[col].notna().mean() * 100:5.1f}%" if col in h else f"  {m:32s} not returned")
    print("\nData: Open-Meteo.com (CC BY 4.0)")


if __name__ == "__main__":
    main()
