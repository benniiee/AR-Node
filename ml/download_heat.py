"""Download hourly history for the AR-Node heat model (campus point, Asia/Manila time).

Two sources, both free for non-commercial use, no API key (attribute
"Weather data by Open-Meteo.com", ERA5 data: Copernicus Climate Change Service):

  data/heat_era5_hourly.csv      Historical Weather API, ERA5 reanalysis (~25 km grid),
                                 https://open-meteo.com/en/docs/historical-weather-api
                                 Used for TRAINING and as the "observed" truth.
  data/heat_forecast_hourly.csv  Historical Forecast API (archived model forecasts, from 2022),
                                 https://open-meteo.com/en/docs/historical-forecast-api
                                 Used only for TESTING: the deployed model receives forecast
                                 inputs, so this shows how much that mismatch costs, and it is
                                 the "Open-Meteo forecast heat index" baseline.

Raw JSON per chunk is cached in data/raw/ (prefix heat_), so a re-run resumes.

Usage:  python download_heat.py --start 2016-01-01
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

from common import DATA, LAT, LON, RAW, TZ
from heat_common import ERA5_CSV, FORECAST_CSV, HEAT_VARS

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"


def fetch(url: str, params: dict) -> dict:
    """GET with back-off on HTTP 429; any other error stops with a readable message."""
    for attempt in range(6):
        try:
            r = requests.get(url, params=params, timeout=90)
        except requests.RequestException as exc:
            if attempt < 3:
                print(f"  connection problem ({exc}); retrying in 10s ...", flush=True)
                time.sleep(10)
                continue
            sys.exit(f"Could not reach Open-Meteo ({exc}). Check the internet connection and try again.")
        if r.status_code == 429:
            wait = 65 * (attempt + 1)
            print(f"  rate limited, waiting {wait}s ...", flush=True)
            time.sleep(wait)
            continue
        if r.status_code >= 400:
            try:
                reason = r.json().get("reason", r.text)
            except ValueError:
                reason = r.text[:300]
            sys.exit(f"Open-Meteo error {r.status_code}: {reason}")
        return r.json()
    sys.exit("Gave up after repeated rate limiting. Try again later.")


def download(kind: str, url: str, start: date, end: date, chunk_days: int, extra: dict, sleep: float) -> pd.DataFrame:
    frames = []
    day = start
    while day <= end:
        stop = min(day + timedelta(days=chunk_days - 1), end)
        cache = RAW / f"heat_{kind}_{LAT:.4f}_{LON:.4f}_{day}_{stop}.json"
        if cache.exists():
            data = json.loads(cache.read_text())
        else:
            print(f"{kind}: fetching {day} -> {stop}", flush=True)
            data = fetch(url, {"latitude": LAT, "longitude": LON, "start_date": str(day), "end_date": str(stop),
                               "hourly": ",".join(HEAT_VARS), "timezone": TZ} | extra)
            cache.write_text(json.dumps(data))
            time.sleep(sleep)
        if "hourly" in data:
            frames.append(pd.DataFrame(data["hourly"]))
        day = stop + timedelta(days=1)
    if not frames:
        sys.exit(f"No {kind} data returned. Check the date range.")
    return pd.concat(frames).drop_duplicates("time").sort_values("time")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2016-01-01", help="first day of the ERA5 history (archive goes back to 1940)")
    ap.add_argument("--end", default=str(date.today() - timedelta(days=7)), help="last day (ERA5 lags ~5 days)")
    ap.add_argument("--forecast-start", default="2022-01-01", help="first day of archived forecasts (API starts ~2022)")
    ap.add_argument("--skip-forecast", action="store_true", help="only download the ERA5 history")
    ap.add_argument("--sleep", type=float, default=0.5, help="pause between requests (seconds)")
    a = ap.parse_args()

    RAW.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(exist_ok=True)
    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)

    era5 = download("era5", ARCHIVE_URL, start, end, 366, {"models": "era5"}, a.sleep)
    era5.to_csv(ERA5_CSV, index=False)
    print(f"\nwrote {ERA5_CSV} ({len(era5):,} rows, {era5['time'].min()} to {era5['time'].max()})")

    if not a.skip_forecast:
        fc = download("forecast", FORECAST_URL, date.fromisoformat(a.forecast_start), end, 92, {}, a.sleep)
        fc.to_csv(FORECAST_CSV, index=False)
        print(f"wrote {FORECAST_CSV} ({len(fc):,} rows, {fc['time'].min()} to {fc['time'].max()})")

    print("Missing share per column (ERA5):")
    print(era5.drop(columns="time").isna().mean().round(3).to_string())
    print("\nData: Open-Meteo.com (CC BY 4.0); ERA5: Copernicus Climate Change Service.")


if __name__ == "__main__":
    main()
