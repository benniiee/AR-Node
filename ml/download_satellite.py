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

--motion (Nov 2026) instead fills data/satellite_motion.csv: for the :10 and :30 scans (the ones training
steps use), the cloud motion against the scan 10 minutes earlier (satellite.scan_motion: two campus strips
per scan, ~3 MB). status "ok", "no_before" (earlier scan not in the archive: the model reads persistence,
like live) or empty (the scan itself is missing).

--cloud fills data/satellite_phase.csv: for the :10 and :20 scans (the ones the :30/:45 training steps use,
cloud_phase.LAG_MIN), the cloud-phase shares around campus (cloud_phase.scan_phase: ~0.15 MB per scan, from
Aug 2023; needs h5py). status "ok" or empty (no phase file for that scan).

Resumable: stop it any time (Ctrl+C or Stop in the GUI) and run it again.

Usage:  python download_satellite.py --start 2024-01-01
        python download_satellite.py --start 2024-04-01 --motion
        python download_satellite.py --start 2024-04-01 --cloud
Data:   JMA Himawari-8/9 via NOAA (https://registry.opendata.aws/noaa-himawari). See satellite.py.
"""
from __future__ import annotations

import argparse
import csv
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

from common import DATA, SAT_B10_CSV, SAT_CSV, SAT_MOTION_CSV, SAT_PHASE_CSV
from satellite import ATTRIBUTION, BAND, MOTION_KEYS, STAT_KEYS, WV_BAND, ScanMissing, motion_stats, scan_stats

COLUMNS = ["stamp", "satellite", *STAT_KEYS]
MOTION_COLUMNS = ["stamp", "status", *MOTION_KEYS]
MOTION_MINUTES = (10, 30)
PHASE_MINUTES = (10, 20)
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


def one_motion(stamp: str) -> tuple[str, dict | None, str | None, int]:
    """Like one(), for satellite_motion.csv: the scan's motion against the scan 10 minutes earlier."""
    from datetime import datetime
    before = (datetime.strptime(stamp, "%Y%m%d_%H%M") - timedelta(minutes=10)).strftime("%Y%m%d_%H%M")
    try:
        now = scan_stats(stamp, keep_box=True)
    except ScanMissing:
        return stamp, None, None, 0
    except Exception as exc:
        return stamp, None, f"{type(exc).__name__}: {exc}", 0
    try:
        prev = scan_stats(before, keep_box=True)
    except ScanMissing:
        return stamp, {"stamp": stamp, "status": "no_before"}, None, int(now["bytes"])
    except Exception as exc:
        return stamp, None, f"{type(exc).__name__}: {exc}", 0
    return stamp, {"stamp": stamp, "status": "ok", **motion_stats(now, prev)}, None, int(now["bytes"]) + int(prev["bytes"])


def one_phase(stamp: str) -> tuple[str, dict | None, str | None, int]:
    """Like one(), for satellite_phase.csv."""
    from cloud_phase import scan_phase
    try:
        p = scan_phase(stamp)
        return stamp, {**p, "status": "ok"}, None, int(p["bytes"])
    except ScanMissing:
        return stamp, None, None, 0
    except Exception as exc:
        return stamp, None, f"{type(exc).__name__}: {exc}", 0


def download(band: int, todo: list[str], path: Path, workers: int, motion: bool = False, phase: bool = False) -> int:
    """Fetch the scans in todo into path; returns how many failed (retried on the next run)."""
    from cloud_phase import PHASE_KEYS
    new_file = not path.exists()
    t0, read, ok, missing, failed = time.time(), 0, 0, 0, 0
    fields = MOTION_COLUMNS if motion else ["stamp", "status", *PHASE_KEYS] if phase else COLUMNS
    # h5py lets one thread read at a time, so the cloud-phase scans run in separate processes.
    executor = ProcessPoolExecutor if phase else ThreadPoolExecutor
    with path.open("a", newline="") as f, executor(max(1, workers)) as pool:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        if new_file:
            w.writeheader()
        job = one_motion if motion else one_phase if phase else None
        futures = [pool.submit(job, s) if job else pool.submit(one, s, band) for s in todo]
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
    ap.add_argument("--motion", action="store_true", help="cloud motion history (data/satellite_motion.csv) instead")
    ap.add_argument("--cloud", action="store_true", help="cloud-phase history (data/satellite_phase.csv, needs h5py) instead")
    a = ap.parse_args()

    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    if start < date(2015, 7, 7) or end < start:
        sys.exit("--start must be 2015-07-07 or later and before --end.")
    DATA.mkdir(exist_ok=True)
    if a.cloud:
        from cloud_phase import FIRST_DAY
        start = max(start, FIRST_DAY.date())
        every = wanted(start, end, PHASE_MINUTES)
        done = done_stamps(SAT_PHASE_CSV)  # once: per scan it re-read the whole file 45,000 times
        todo = [s for s in every if s not in done]
        print(f"cloud phase ({SAT_PHASE_CSV.name}) {start} -> {end}: {len(every):,} scans, {len(every) - len(todo):,} "
              f"already done, {len(todo):,} to go (about {len(todo) * 0.15 / 1024:.1f} GB)", flush=True)
        # One process per worker (h5py); more than 16 crashed processes on Windows in a Nov 2026 test.
        if todo and download(BAND, todo, SAT_PHASE_CSV, min(a.workers, 16), phase=True):
            print("Some scans failed (network). Run the download again to fetch them.")
        print("Data: NOAA Enterprise cloud phase for Himawari-9 (registry.opendata.aws/noaa-himawari)")
        return
    if a.motion:
        every = wanted(start, end, MOTION_MINUTES)
        done = done_stamps(SAT_MOTION_CSV)
        todo = [s for s in every if s not in done]
        print(f"cloud motion ({SAT_MOTION_CSV.name}) {start} -> {end}: {len(every):,} scans, {len(every) - len(todo):,} "
              f"already done, {len(todo):,} to go (about {len(todo) * 2.6 / 1024:.1f} GB, two strips each)", flush=True)
        if todo and download(BAND, todo, SAT_MOTION_CSV, a.workers, motion=True):
            print("Some scans failed (network). Run the download again to fetch them.")
        print(f"Data: {ATTRIBUTION}")
        return
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
