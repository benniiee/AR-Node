"""Download real airport observations (METAR) for ground-truth rain labels.

Source: Iowa Environmental Mesonet (IEM) global METAR archive, free and open:
https://mesonet.agron.iastate.edu/request/download.phtml
Default station RPMZ = Zamboanga International Airport (close to the campus).
METAR "present weather" codes (RA rain, DZ drizzle, SH showers, TS thunderstorm)
say whether it was ACTUALLY raining, unlike model data. Reports come roughly
every 30-60 minutes (plus specials), so this is sparse but real truth.

IEM asks users to be gentle (IP rate limit, HTTP 503 when busy): this script
fetches one year per request with a pause.

Usage:
  python download_metar.py --start 2022-01-01
  python download_metar.py --list-stations      # if RPMZ returns nothing
"""
from __future__ import annotations

import argparse
import io
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

from common import DATA, METAR_CSV

ASOS = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
NETWORK_API = "https://mesonet.agron.iastate.edu/api/1/network/PH__ASOS.json"


def list_stations() -> None:
    r = requests.get(NETWORK_API, timeout=60)
    r.raise_for_status()
    rows = r.json().get("data", [])
    print(f"{len(rows)} Philippine stations in IEM:")
    for s in rows:
        print(f"  {s.get('stid', s.get('id')):6} {s.get('name')}  ({s.get('latitude', s.get('lat'))}, {s.get('longitude', s.get('lon'))})")


def fetch_year(station: str, start: date, end: date) -> pd.DataFrame:
    params = {
        "station": station, "data": "all",
        "sts": f"{start}T00:00Z", "ets": f"{end}T23:59Z",
        "tz": "Etc/UTC", "format": "onlycomma", "missing": "empty", "trace": "T",
        "latlon": "no", "elev": "no", "direct": "no",
    }
    for attempt in range(5):
        r = requests.get(ASOS, params=params, timeout=120)
        if r.status_code in (429, 503):
            wait = 30 * (attempt + 1)
            print(f"  server busy ({r.status_code}), waiting {wait}s ...", flush=True)
            time.sleep(wait)
            continue
        r.raise_for_status()
        if "station,valid" not in r.text:
            return pd.DataFrame()  # empty answer: unknown station or no data in range
        return pd.read_csv(io.StringIO(r.text), comment="#", dtype=str)
    sys.exit("IEM kept refusing the request. Try again later.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--station", default="RPMZ")
    ap.add_argument("--start", default="2022-01-01")
    ap.add_argument("--end", default=str(date.today() - timedelta(days=1)))
    ap.add_argument("--list-stations", action="store_true")
    a = ap.parse_args()
    if a.list_stations:
        return list_stations()

    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    frames = []
    year = start.year
    while year <= end.year:
        s = max(start, date(year, 1, 1))
        e = min(end, date(year, 12, 31))
        print(f"fetching {a.station} {s} -> {e}", flush=True)
        df = fetch_year(a.station, s, e)
        print(f"  {len(df):,} reports")
        if len(df):
            frames.append(df)
        time.sleep(2)
        year += 1

    if not frames:
        sys.exit(f"No METAR rows for {a.station}. Run with --list-stations and check the IEM download page.")
    df = pd.concat(frames).drop_duplicates(["station", "valid"]).sort_values("valid")
    df = df[["station", "valid", "wxcodes", "tmpf", "relh", "metar"]] if "metar" in df.columns else df
    DATA.mkdir(exist_ok=True)
    df.to_csv(METAR_CSV, index=False)
    wx = df["wxcodes"].fillna("")
    print(f"\nwrote {METAR_CSV} ({len(df):,} reports, {int((wx != '').sum()):,} with present-weather codes)")
    print("Data: Iowa Environmental Mesonet / station METAR (as-is, minimal quality control).")


if __name__ == "__main__":
    main()
