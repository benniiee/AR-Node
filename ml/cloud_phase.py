"""Himawari cloud-top PHASE around campus for the rain model (optional; needs the h5py package).

Why: the infrared and water-vapour inputs (satellite.py) see cold, tall storm clouds, but not rain from
low, warm water clouds (the drizzle the model missed on 2026-11-16). NOAA's cloud-phase product says, per
2 km pixel, whether the cloud top is liquid water, supercooled water, mixed or ice.

Source: NOAA Enterprise cloud products for Himawari-9 on AWS (registry.opendata.aws/noaa-himawari), folder
AHI-L2-FLDK-Clouds, file AHI-CPHS_*.nc, variable CloudPhase: 0 clear, 1 liquid water, 2 supercooled water,
3 mixed, 4 ice, 5 unknown (NOAA cloud-phase readme). From Aug 2023, every 10 minutes, online about 15-20
minutes after the scan starts. The files are 87 MB for the whole disk, but they are stored in compressed
200 x 200 pixel tiles, so reading only the campus tile over HTTP ranges costs about 0.2 MB per scan.
(The same file has a CloudType variable, but its numbering in these files is not documented, so it is not used.)

One module for both uses, like satellite.py:
  * download_satellite.py --cloud  -> scan_phase() for every :10/:20 scan -> data/satellite_phase.csv
  * common.build_sat_features(..., phase=) / live `satellite.py now --cloud` -> features_at()
"""
from __future__ import annotations

import io
import math
import re
import urllib.request
from datetime import datetime, timedelta

from satellite import AREA_KM, LAT, LON, NEAR_KM, UA, ScanMissing, _fetch, _geometry, _get, stamp_of

BUCKET = "https://noaa-himawari9.s3.amazonaws.com"
FIRST_DAY = datetime(2023, 8, 1)
LAG_MIN = 20            # a scan's phase file is online this long after the scan starts (14-18 min measured, Nov 2026)
MAX_AGE_MIN = 50        # an older phase scan = missing
PHASE_KEYS = ["water_10km", "supercooled_10km", "ice_10km", "cloudy_30km"]
# sat_phase_missing: 1 when no phase scan is recent enough (the shares are then 0). Training keeps those steps
# instead of dropping them (NOAA has no phase files for 12 Oct - 25 Nov 2025), and live a late file is no outage.
CLOUD_FEATURES = ["sat_phase_water_10km", "sat_phase_supercooled_10km", "sat_phase_ice_10km", "sat_phase_cloudy_30km",
                  "sat_phase_missing"]
# Nominal full-disk 2 km grid (the same constants satellite._segment() uses); line 1 = the first full-disk line.
NOMINAL = dict(sub_lon=140.7, cfac=20466275, lfac=20466275, coff=2750.5, loff=2750.5, dist=42164.0, req=6378.137,
               rpol=6356.7523, first_line=1)


class _RangeFile(io.RawIOBase):
    """Read-only, seekable file over HTTP Range requests (32 kB blocks, cached), for h5py."""

    BLOCK = 32 * 1024

    def __init__(self, url: str, size: int):
        self.url, self.size, self.pos, self.blocks, self.read_bytes = url, size, 0, {}, 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, b) -> int:
        n, out, got = max(0, min(len(b), self.size - self.pos)), memoryview(b), 0
        while got < n:
            i, off = divmod(self.pos + got, self.BLOCK)
            if i not in self.blocks:
                start = i * self.BLOCK
                self.blocks[i] = _get(self.url, start, min(self.size, start + self.BLOCK) - 1)
                self.read_bytes += len(self.blocks[i])
            blk = self.blocks[i]
            take = min(n - got, len(blk) - off)
            if take <= 0:
                raise OSError("short read")
            out[got:got + take] = blk[off:off + take]
            got += take
        self.pos += n
        return n


def phase_url(stamp: str) -> tuple[str, int]:
    """URL and size of scan 'YYYYMMDD_HHMM' (UTC)'s cloud-phase file (its name ends in the creation time, so it is listed)."""
    t = datetime.strptime(stamp, "%Y%m%d_%H%M")
    prefix = f"AHI-L2-FLDK-Clouds/{t:%Y/%m/%d/%H%M}/AHI-CPHS_"
    xml = _fetch(urllib.request.Request(f"{BUCKET}/?list-type=2&prefix={prefix}", headers=UA)).decode()
    found = re.search(r"<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>", xml, re.S)
    if not found:
        raise ScanMissing(stamp)
    return f"{BUCKET}/{found.group(1)}", int(found.group(2))


def scan_phase(stamp: str) -> dict:
    """Cloud-phase shares around campus for one scan: water_10km (liquid water), supercooled_10km, ice_10km
    (shares of the valid pixels within NEAR_KM) and cloudy_30km (any cloud within AREA_KM).
    Raises ScanMissing when the scan has no phase file."""
    import h5py  # optional dependency: only this product needs it

    url, size = phase_url(stamp)
    g = _geometry(NOMINAL)
    r = g["r"]
    raw = _RangeFile(url, size)
    f = h5py.File(raw, "r")
    try:
        box = f["CloudPhase"][g["row"] - r: g["row"] + r + 1, g["col"] - r: g["col"] + r + 1].tolist()
    finally:
        f.close()  # before the file object goes away (h5py crashes at exit otherwise)
    near, area = [], []
    for i, line in enumerate(box):
        for j, v in enumerate(line):
            if not 0 <= v <= 4:  # fill (-128) or unknown (5)
                continue
            d = math.hypot((j - r) * g["kx"], (i - r) * g["ky"])
            if d <= NEAR_KM:
                near.append(v)
            if d <= AREA_KM:
                area.append(v)
    if not near or not area:
        raise ScanMissing(f"{stamp}: no valid phase pixels around campus")
    share = lambda vals, codes: round(sum(1 for v in vals if v in codes) / len(vals), 5)  # noqa: E731
    return {"stamp": stamp, "water_10km": share(near, (1,)), "supercooled_10km": share(near, (2,)),
            "ice_10km": share(near, (3, 4)), "cloudy_30km": share(area, (1, 2, 3, 4)), "bytes": raw.read_bytes}


def latest_phase_scan(t_utc: datetime) -> datetime:
    """Start time of the newest scan whose phase file is online at t (scan start + LAG_MIN <= t)."""
    s = t_utc - timedelta(minutes=LAG_MIN)
    return s.replace(minute=s.minute - s.minute % 10, second=0, microsecond=0)


def candidates(t_local: datetime) -> list[str]:
    """Scans that may serve step t (Asia/Manila, naive), newest first, within MAX_AGE_MIN."""
    t_utc = t_local - timedelta(hours=8)
    first = latest_phase_scan(t_utc)
    return [stamp_of(first - timedelta(minutes=b)) for b in range(0, MAX_AGE_MIN + 1, 10)
            if (t_utc - (first - timedelta(minutes=b))).total_seconds() / 60 <= MAX_AGE_MIN]


def features_at(t_local: datetime, phases: dict) -> dict:
    """CLOUD_FEATURES for step t from {stamp: scan_phase() stats}: the newest scan online at t. When none is
    recent enough: shares 0 and sat_phase_missing 1. MUST be the only implementation: training and live both call it."""
    for stamp in candidates(t_local):
        p = phases.get(stamp)
        if p:
            return {**{f"sat_phase_{k}": float(p[k]) for k in PHASE_KEYS}, "sat_phase_missing": 0.0}
    return {**{f"sat_phase_{k}": 0.0 for k in PHASE_KEYS}, "sat_phase_missing": 1.0}


def live(t_local: datetime) -> dict:
    """CLOUD_FEATURES right now; "missing" when no phase scan is online (h5py missing raises ImportError)."""
    for stamp in candidates(t_local):
        try:
            return features_at(t_local, {stamp: scan_phase(stamp)})
        except ScanMissing:
            continue
    return features_at(t_local, {})
