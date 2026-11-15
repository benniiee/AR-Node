"""Download Himawari-8/9 satellite history around the campus for the rain model.

For each scan, satellite.scan_stats() downloads only the campus strip of one band of the image
(about 1.1-1.5 MB, from NOAA's open copy on AWS, no account), reads the temperatures around campus
and keeps 10 numbers. The images themselves are never saved, so the output stays a few MB.

Scans used (UTC minutes of every hour). Training uses the routine :30/:45 steps; such a step t uses the
newest scan online at t (scan start + 12 min), i.e. the :10 or :30 scan, plus (satellite.features_at):
  band 13 (cloud tops)    :00 :10 :20 :30 :50  - the newest scan and the scans 10 and 20 minutes before it
  band 10 (water vapour)  :10 :30              - the newest scan only
Live, every 10-minute scan is available and the same rule applies.

Writes data/satellite_b13.csv and data/satellite_b10.csv: stamp (scan start, UTC YYYYMMDD_HHMM), satellite,
campus_bt, mean_10km, min_10km, min_30km, cold_10km, cold_30km, cold_n, cold_e, cold_s, cold_w (degrees C
and shares of pixels colder than -40 C). Scans missing from the archive are written with an empty
satellite column so a re-run does not ask for them again; network errors are retried on the next run.

Resumable: stop it any time (Ctrl+C or Stop in the GUI) and run it again.

Usage:  python download_satellite.py --start 2024-01-01
Data:   JMA Himawari-8/9 via NOAA (https://registry.opendata.aws/noaa-himawari). See satellite.py.
"""
from __future__ import annotations

import argparse
import csv
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

from common import DATA, SAT_B10_CSV, SAT_CSV
from satellite import ATTRIBUTION, BAND, STAT_KEYS, WV_BAND, ScanMissing, scan_stats

COLUMNS = ["stamp", "satellite", *STAT_KEYS]
# (band, minutes, output file, MB read per scan)
JOBS = [(BAND, (0, 10, 20, 30, 50), SAT_CSV, 1.5), (WV_BAND, (10, 30), SAT_B10_CSV, 1.15)]


def wanted(start: date, end: date, minutes) -> list[str]:
    out, day = [], start
    while day <= end:
        for hour in range(24):
            for minute in minutes:
                out.append(f"{day:%Y%m%d}_{hour:02d}{minute:02d}")
        day += timedelta(days=1)
    return out


def done_stamps(path: Path) -> set[str]:
    if not path.exists():
        return set()
    with path.open(newline="") as f:
        return {row["stamp"] for row in csv.DictReader(f)}


def one(stamp: str, band: int = BAND) -> tuple[str, dict | None, str | None, int]:
    """(stamp, stats or None when missing from the archive, error text for a retryable failure, bytes)."""
    try:
        s = scan_stats(stamp, band)
        return stamp, s, None, int(s.get("bytes", 0))
    except ScanMissing:
        return stamp, None, None, 0
    except Exception as exc:  # network trouble: not written, so the next run retries it
        return stamp, None, f"{type(exc).__name__}: {exc}", 0


def download(band: int, todo: list[str], path: Path, workers: int) -> int:
    """Fetch the scans in todo into path; returns how many failed (retried on the next run)."""
    new_file = not path.exists()
    t0, read, ok, missing, failed = time.time(), 0, 0, 0, 0
    with path.open("a", newline="") as f, ThreadPoolExecutor(max(1, workers)) as pool:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        if new_file:
            w.writeheader()
        futures = [pool.submit(one, s, band) for s in todo]
        try:
            for i, fut in enumerate(as_completed(futures), 1):
                stamp, stats, error, nbytes = fut.result()
                read += nbytes
                if stats is not None:
                    w.writerow(stats)
                    ok += 1
                elif error is None:
                    w.writerow({"stamp": stamp})  # not in the archive: remembered, never asked again
                    missing += 1
                else:
                    failed += 1
                    if failed <= 5:
                        print(f"  {stamp}: {error} (will retry on the next run)", flush=True)
                if i % 200 == 0 or i == len(todo):
                    f.flush()
                    rate = i / max(time.time() - t0, 1e-6)
                    left = (len(todo) - i) / rate if rate else 0
                    print(f"  band {band}: {i:,}/{len(todo):,} scans  ({read / 1e9:.2f} GB read, {rate:.1f}/s, "
                          f"about {left / 3600:.1f} h left)  ok={ok:,} missing={missing:,} errors={failed:,}", flush=True)
        except KeyboardInterrupt:
            for fut in futures:
                fut.cancel()
            print("\nstopped; run again to continue", flush=True)
            raise
    print(f"wrote {path}: {ok:,} scans read, {missing:,} not in the archive, {failed:,} to retry\n", flush=True)
    return failed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2024-01-01", help="first day (UTC); the 9-model forecasts start 2024-01-01, "
                                                         "so earlier satellite history is not used by training")
    ap.add_argument("--end", default=str(date.today() - timedelta(days=1)), help="last day (UTC), default = yesterday")
    ap.add_argument("--workers", type=int, default=24, help="parallel downloads (default 24, about 3 scans/s)")
    a = ap.parse_args()

    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    if start < date(2015, 7, 7) or end < start:
        sys.exit("--start must be 2015-07-07 or later and before --end.")
    DATA.mkdir(exist_ok=True)
    plans = []
    for band, minutes, path, mb in JOBS:
        done = done_stamps(path)  # once per file: calling it per scan re-read the whole file 49,000 times
        every = wanted(start, end, minutes)
        todo = [s for s in every if s not in done]
        plans.append((band, todo, path))
        print(f"band {band} ({path.name}) {start} -> {end}: {len(every):,} scans, {len(every) - len(todo):,} already done, "
              f"{len(todo):,} to go (about {len(todo) * mb / 1024:.1f} GB)", flush=True)
    print("only the campus strip of each image is read; nothing but the extracted numbers is kept\n", flush=True)
    failed = sum(download(band, todo, path, a.workers) for band, todo, path in plans if todo)
    if failed:
        print("Some scans failed (network). Run the download again to fetch them.")
    print(f"Data: {ATTRIBUTION}")


if __name__ == "__main__":
    main()
