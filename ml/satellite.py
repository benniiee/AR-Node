"""Himawari satellite cloud-top inputs for the rain model (standard library only).

One module for all three uses, so training and live inputs are the same numbers by construction:
  * download_satellite.py  -> scan_stats() for every history scan -> data/satellite_b13.csv, satellite_b10.csv
  * common.build_sat_features() -> features_at() per 15-minute step, for training
  * live (ml GUI and the Laravel app):  python satellite.py now --at 2026-11-13T00:15 --wind-dir 80 [--motion]
    prints one JSON object; WeatherService passes its "features" to RainModel. --motion (only when the
    model reads the cloud-motion inputs) downloads the scan 10 minutes back again for its pixels; --cloud
    (only when it reads the cloud-phase inputs) adds cloud_phase.py's, and fails without them.

What is read, from the full-disk scan every 10 minutes, only the strip of the image over the campus
(segment 5 of 10), from NOAA's open copy on AWS (no account):
  * band 13 (10.4 um infrared, day and night): how cold the cloud TOPS are. Deep storm clouds have tops
    colder than about -40 C, so a cold, growing cloud over or upwind of campus is an early sign of a
    downpour. Read for the newest scan and the scans 10 and 20 minutes before it (is it growing NOW?).
  * band 10 (7.3 um water vapour): the upper air. Only clouds that reach it look as cold in band 10 as
    in band 13, so "band 10 minus band 13" near 0 marks a deep storm cloud, not just a high thin one.
  * cloud motion (Nov 2026): the band-13 box around campus in the newest scan is matched against the scan
    10 minutes before it (block matching: the shift with the smallest mean difference). Moving the clouds
    on by that shift twice gives the cloud expected over campus in 20 minutes (sat_adv_*), so a storm
    cloud drifting toward campus counts before it arrives. Simple extrapolation: it cannot see new
    clouds forming (the cooling inputs cover growth). History: download_satellite.py --motion.
It cannot see light rain from low, warm clouds.

Data: Japan Meteorological Agency (JMA) Himawari-8/9, distributed by NOAA
(https://registry.opendata.aws/noaa-himawari). NOAA and JMA ask for attribution, and nothing
here may imply their endorsement. The values ARNode derives are its own, not original JMA data.
"""
from __future__ import annotations

import argparse
import bz2
import json
import math
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

LAT, LON = 6.913097, 122.062156  # same campus point as common.py
BAND = 13
WV_BAND = 10            # water vapour; only for the newest scan
COLD_C = -40.0          # colder cloud tops = deep (storm) cloud
NEAR_KM, AREA_KM = 10.0, 30.0
LAG_MIN = 12            # a scan's campus strip is online about 12 min after the scan starts (measured 2026-11-12)
MAX_AGE_MIN = 50        # an older scan = satellite missing
COOLING_MIN = 20        # cloud-top change compared with the scan this many minutes earlier
STAT_KEYS = ["campus_bt", "mean_10km", "min_10km", "min_30km", "cold_10km", "cold_30km",
             "cold_n", "cold_e", "cold_s", "cold_w"]
# Model inputs. features_at() also returns "sat_age_min" (how old the scan is) for checks, but it is not an
# input: in training only the extra (special) airport reports label the :00/:15 steps, and those are mostly
# rain with older scans, so scan age "predicted" rain through how the rows were chosen, not the weather.
SAT_FEATURES = ["sat_bt_campus", "sat_bt_min_10km", "sat_bt_min_30km", "sat_cold_10km", "sat_cold_30km",
                "sat_cooling_20min", "sat_upwind_cold",
                "sat_cooling_10min", "sat_min_cooling_10min", "sat_sustained_cooling",
                "sat_wv_campus", "sat_wv_minus_ir_campus", "sat_wv_minus_ir_10km", "sat_wv_min_30km"]
# Cloud-motion inputs (features_at(..., motion=...)); kept apart from SAT_FEATURES so models trained without
# them are unchanged. Persistence (no motion, today's campus values) when the earlier scan is missing.
# sat_motion_missing: 1 when that scan's motion was not downloaded (download_satellite.py --every keeps only
# 1 scan in N); the others then read as persistence. Live, motion is always computed, so it is 0.
MOTION_FEATURES = ["sat_motion_kmh", "sat_adv_bt_20min", "sat_adv_cold_20min", "sat_adv_minus_campus", "sat_motion_missing"]
MOTION_KEYS = ["speed_kmh", "shift_e_km", "shift_n_km", "adv_bt", "adv_cold"]
MOTION_MAX_PX = 6         # search +-6 pixels (2 km) per 10 minutes = up to ~70 km/h
MOTION_MIN_TEXTURE = 1.0  # deg C: a box flatter than this (clear sky, flat overcast) gives no usable motion
ATTRIBUTION = "Himawari-8/9 data: Japan Meteorological Agency (JMA), distributed by NOAA (registry.opendata.aws/noaa-himawari)"

# Himawari-9 took over from Himawari-8 on 2022-12-13 at 05:00 UTC.
H9_FROM = datetime(2022, 12, 13, 5, 0)
CHUNK = 262_144
UA = {"User-Agent": "ARNode-campus-weather/1.0"}


class ScanMissing(Exception):
    """The scan is not in the bucket (yet): skip it, do not retry."""


# ------------------------------------------------------------------ download + decode
def scan_key(stamp: str, band: int = BAND) -> tuple[str, str]:
    """Bucket URL and object key of one band's campus segment of scan 'YYYYMMDD_HHMM' (UTC)."""
    t = datetime.strptime(stamp, "%Y%m%d_%H%M")
    sat = "9" if t >= H9_FROM else "8"
    seg = _segment()
    key = (f"AHI-L1b-FLDK/{t:%Y/%m/%d/%H%M}/"
           f"HS_H0{sat}_{t:%Y%m%d_%H%M}_B{band:02d}_FLDK_R20_S{seg:02d}10.DAT.bz2")
    return f"https://noaa-himawari{sat}.s3.amazonaws.com", key


def _segment() -> int:
    # Nominal 2 km AHI grid: 5500 lines in 10 segments; the header confirms the exact line later.
    _, line = _project(LAT, LON, 140.7, 20466275, 20466275, 2750.5, 2750.5, 42164.0, 6378.137, 6356.7523)
    return int((line - 1) // 550) + 1


# A dropped connection, a failed name lookup (this PC's DNS drops out for several seconds at a
# time: "getaddrinfo failed", Nov 2026) or a server error is retried after these waits, then the
# read gives up and the app scores its model without satellite. Worst case about 90 s, inside
# weather.satellite_timeout.
RETRY_WAITS_S = (1, 2, 4, 8)
NET_TIMEOUT_S = 15


def _fetch(req: urllib.request.Request) -> bytes:
    """The response body, retrying network and server errors (other HTTP errors are raised at once)."""
    for wait in (*RETRY_WAITS_S, None):
        try:
            with urllib.request.urlopen(req, timeout=NET_TIMEOUT_S) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or wait is None:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if wait is None:
                raise
        time.sleep(wait)
    return b""


def _get(url: str, start: int, end: int) -> bytes:
    try:
        return _fetch(urllib.request.Request(url, headers={**UA, "Range": f"bytes={start}-{end}"}))
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 404):
            raise ScanMissing(url) from exc
        if exc.code == 416:  # range past the end of the file
            return b""
        raise


def fetch_rows(stamp: str, rows_needed, band: int = BAND) -> tuple[dict, bytes, int]:
    """Download only as much of the compressed segment as needed for the campus rows.

    Returns (header, decompressed bytes, compressed bytes read). rows_needed(header) -> last row index.
    """
    host, key = scan_key(stamp, band)
    url = f"{host}/{key}"
    dec = bz2.BZ2Decompressor()
    out, pos, header, need = bytearray(), 0, None, None
    while True:
        data = _get(url, pos, pos + CHUNK - 1)
        pos += len(data)
        pending = data
        # The files are several bz2 streams back to back (one per ~900 kB block).
        while pending:
            out += dec.decompress(pending)
            if dec.eof:
                pending, dec = dec.unused_data, bz2.BZ2Decompressor()
            else:
                pending = b""
        if header is None and len(out) >= 74:
            total_header = struct.unpack_from("<I", out, 70)[0]
            if len(out) >= total_header:
                header = _header(bytes(out[:total_header]))
                need = total_header + (rows_needed(header) + 1) * header["cols"] * 2
        if need is not None and len(out) >= need:
            return header, bytes(out[:need]), pos
        if not data or len(data) < CHUNK:
            raise ValueError(f"{stamp}: file ended before the campus rows")


def _header(data: bytes) -> dict:
    """Header blocks of a Himawari Standard Data file (HSD v1.3) that are needed here."""
    off, blocks = 0, {}
    total = struct.unpack_from("<I", data, 70)[0]
    while off < total:
        num, length = struct.unpack_from("<BH", data, off)
        if length == 0:
            break
        blocks[num] = data[off:off + length]
        off += length
    b2, b3, b5, b7 = blocks[2], blocks[3], blocks[5], blocks[7]
    cols, lines = struct.unpack_from("<HH", b2, 5)
    sub_lon, cfac, lfac, coff, loff = struct.unpack_from("<dIIff", b3, 3)
    dist, req, rpol = struct.unpack_from("<ddd", b3, 27)
    band, wavelength, valid_bits, err_count, out_count = struct.unpack_from("<HdHHH", b5, 3)
    gain, offset = struct.unpack_from("<dd", b5, 19)
    c0, c1, c2, _, _, _, c, h, k = struct.unpack_from("<9d", b5, 35)
    first_line = struct.unpack_from("<H", b7, 5)[0]
    return dict(total=total, cols=cols, lines=lines, sub_lon=sub_lon, cfac=cfac, lfac=lfac, coff=coff, loff=loff,
                dist=dist, req=req, rpol=rpol, band=band, wl=wavelength, bits=valid_bits, err=err_count, out=out_count,
                gain=gain, offset=offset, c0=c0, c1=c1, c2=c2, c=c, h=h, k=k, first_line=first_line)


def _project(lat, lon, sub_lon, cfac, lfac, coff, loff, dist, req, rpol) -> tuple[float, float]:
    """Latitude/longitude -> (column, full-disk line), CGMS normalized geostationary projection (1-based)."""
    phi, lam = math.radians(lat), math.radians(lon - sub_lon)
    e2 = 1 - (rpol / req) ** 2
    c_lat = math.atan((rpol / req) ** 2 * math.tan(phi))
    rl = rpol / math.sqrt(1 - e2 * math.cos(c_lat) ** 2)
    r1 = dist - rl * math.cos(c_lat) * math.cos(lam)
    r2 = -rl * math.cos(c_lat) * math.sin(lam)
    r3 = rl * math.sin(c_lat)
    rn = math.sqrt(r1 * r1 + r2 * r2 + r3 * r3)
    x = math.degrees(math.atan(-r2 / r1))
    y = math.degrees(math.asin(-r3 / rn))
    return coff + x * cfac / 2 ** 16, loff + y * lfac / 2 ** 16


def _pixel(h: dict, lat: float, lon: float) -> tuple[float, float]:
    return _project(lat, lon, h["sub_lon"], h["cfac"], h["lfac"], h["coff"], h["loff"], h["dist"], h["req"], h["rpol"])


def _geometry(h: dict) -> dict:
    """Campus pixel, km per pixel and the box that covers AREA_KM around campus."""
    col, line = _pixel(h, LAT, LON)
    d = 0.05
    c_e, l_e = _pixel(h, LAT, LON + d)
    c_n, l_n = _pixel(h, LAT + d, LON)
    km_lon, km_lat = 111.32 * math.cos(math.radians(LAT)) * d, 110.57 * d
    # km per column / per line (small-angle: the grid is close to east-west / north-south here)
    kx = km_lon / math.hypot(c_e - col, l_e - line)
    ky = km_lat / math.hypot(c_n - col, l_n - line)
    north_sign = -1 if l_n < line else 1   # lines grow southward on Himawari
    r = int(math.ceil(AREA_KM / min(kx, ky))) + 1
    row = int(round(line)) - h["first_line"]
    cc = int(round(col)) - 1
    return dict(row=row, col=cc, kx=kx, ky=ky, r=r, north_sign=north_sign)


def _bt_lookup(h: dict) -> list[float | None]:
    """Count -> brightness temperature in C (None for error/outside-scan counts)."""
    lam = h["wl"] * 1e-6
    table: list[float | None] = []
    for count in range(1 << h["bits"]):
        if count in (h["err"], h["out"]):
            table.append(None)
            continue
        rad = count * h["gain"] + h["offset"]
        if rad <= 0:
            table.append(None)
            continue
        te = h["h"] * h["c"] / (h["k"] * lam) / math.log(2 * h["h"] * h["c"] ** 2 / (lam ** 5 * rad * 1e6) + 1)
        table.append(h["c0"] + h["c1"] * te + h["c2"] * te * te - 273.15)
    return table


def scan_box(stamp: str, band: int = BAND) -> tuple[dict, list[list[float | None]], int]:
    """(geometry, box, compressed bytes read) for one scan and band: box[dr + r][dc + r] is the brightness
    temperature (C, None = no valid count) at campus row + dr, column + dc, for |dr|, |dc| <= r."""
    state = {}

    def last_row(h: dict) -> int:
        g = _geometry(h)
        state["g"] = g
        return g["row"] + g["r"]

    h, data, read = fetch_rows(stamp, last_row, band)
    g = state["g"]
    if g["row"] - g["r"] < 0 or g["row"] + g["r"] >= h["lines"]:
        raise ValueError("campus box crosses a segment edge")
    lut = _bt_lookup(h)
    cols, base = h["cols"], h["total"]

    def bt(r: int, c: int) -> float | None:
        count = struct.unpack_from("<H", data, base + (r * cols + c) * 2)[0]
        return lut[count] if count < len(lut) else None

    box = [[bt(g["row"] + dr, g["col"] + dc) for dc in range(-g["r"], g["r"] + 1)] for dr in range(-g["r"], g["r"] + 1)]
    return g, box, read


def scan_stats(stamp: str, band: int = BAND, keep_box: bool = False) -> dict:
    """Brightness-temperature statistics around campus for one scan and band (13 = cloud tops,
    10 = water vapour; bands 7-16 share the 2 km grid). Raises ScanMissing when it is not online.
    keep_box adds "geometry" and "box" (scan_box), for motion_stats()."""
    g, box, read = scan_box(stamp, band)
    campus, near, area = [], [], []
    quad = {"n": [], "e": [], "s": [], "w": []}
    for dr in range(-g["r"], g["r"] + 1):
        for dc in range(-g["r"], g["r"] + 1):
            v = box[dr + g["r"]][dc + g["r"]]
            if v is None:
                continue
            east, north = dc * g["kx"], dr * g["ky"] * g["north_sign"]
            dist = math.hypot(east, north)
            if abs(dr) <= 1 and abs(dc) <= 1:
                campus.append(v)
            if dist <= NEAR_KM:
                near.append(v)
            if dist <= AREA_KM:
                area.append(v)
                if dist > 0:
                    bearing = math.degrees(math.atan2(east, north)) % 360
                    quad[_quadrant(bearing)].append(v)
    if not campus or not near or not area:
        # A blank (corrupt) image in the archive: permanent, so treated like a missing scan, never retried.
        raise ScanMissing(f"{stamp}: no valid pixels around campus")
    share = lambda vals: sum(1 for v in vals if v < COLD_C) / len(vals) if vals else 0.0
    return {
        "stamp": stamp, "satellite": "H09" if datetime.strptime(stamp, "%Y%m%d_%H%M") >= H9_FROM else "H08",
        "campus_bt": round(sum(campus) / len(campus), 3), "mean_10km": round(sum(near) / len(near), 3),
        "min_10km": round(min(near), 3), "min_30km": round(min(area), 3),
        "cold_10km": round(share(near), 5), "cold_30km": round(share(area), 5),
        **{f"cold_{q}": round(share(v), 5) for q, v in quad.items()},
        "bytes": read,
        **({"geometry": g, "box": box} if keep_box else {}),
    }


def motion_stats(now: dict, before: dict) -> dict:
    """Cloud motion between two band-13 scans 10 minutes apart (scan_stats(..., keep_box=True)), and the cloud
    that motion brings over campus in 20 minutes. Block matching: the shift (up to MOTION_MAX_PX pixels) that
    makes the earlier box best match the newest one, over the box's inner part. A box with almost no contrast
    (MOTION_MIN_TEXTURE) or a tie keeps the smallest shift, so clear sky reads as "no motion".

    Returns speed_kmh, shift_e_km / shift_n_km (per 10 minutes, toward east / north), adv_bt (mean of the 3x3
    pixels the clouds come from, C) and adv_cold (share of pixels colder than COLD_C within NEAR_KM of there).
    """
    g, a, b = now["geometry"], now["box"], before["box"]
    r, m = g["r"], MOTION_MAX_PX
    inner = r - m
    vals = [a[r + i][r + j] for i in range(-inner, inner + 1) for j in range(-inner, inner + 1) if a[r + i][r + j] is not None]
    mean = sum(vals) / len(vals) if vals else 0.0
    texture = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals)) if vals else 0.0
    best = (0, 0)
    if texture >= MOTION_MIN_TEXTURE:
        scored = []
        for dy in range(-m, m + 1):
            for dx in range(-m, m + 1):
                total, n = 0.0, 0
                for i in range(-inner, inner + 1):
                    row_a, row_b = a[r + i], b[r + i - dy]
                    for j in range(-inner, inner + 1):
                        va, vb = row_a[r + j], row_b[r + j - dx]
                        if va is not None and vb is not None:
                            total += abs(va - vb)
                            n += 1
                if n:
                    scored.append((round(total / n, 6), dy * dy + dx * dx, dy, dx))
        if scored:
            _, _, dy, dx = min(scored)
            best = (dy, dx)
    dy, dx = best
    # The cloud over campus in 20 minutes is now two shifts upstream (clamped to the box).
    uy, ux = max(-r + 1, min(r - 1, -2 * dy)), max(-r + 1, min(r - 1, -2 * dx))
    around = [a[r + uy + i][r + ux + j] for i in (-1, 0, 1) for j in (-1, 0, 1) if a[r + uy + i][r + ux + j] is not None]
    near = []
    for i in range(-r, r + 1):
        for j in range(-r, r + 1):
            v = a[r + i][r + j]
            if v is not None and math.hypot((j - ux) * g["kx"], (i - uy) * g["ky"]) <= NEAR_KM:
                near.append(v)
    east, north = dx * g["kx"], dy * g["ky"] * g["north_sign"]
    campus = [a[r + i][r + j] for i in (-1, 0, 1) for j in (-1, 0, 1) if a[r + i][r + j] is not None]
    return {
        "speed_kmh": round(math.hypot(east, north) * 6, 3), "shift_e_km": round(east, 3), "shift_n_km": round(north, 3),
        "adv_bt": round(sum(around) / len(around), 3) if around else round(sum(campus) / len(campus), 3),
        "adv_cold": round(sum(1 for v in near if v < COLD_C) / len(near), 5) if near else 0.0,
    }


def scan_motion(stamp: str) -> dict:
    """motion_stats() for scan 'YYYYMMDD_HHMM' and the scan 10 minutes before it (two downloads).
    Raises ScanMissing when either is not in the archive."""
    before = (datetime.strptime(stamp, "%Y%m%d_%H%M") - timedelta(minutes=10)).strftime("%Y%m%d_%H%M")
    return {"stamp": stamp, **motion_stats(scan_stats(stamp, keep_box=True), scan_stats(before, keep_box=True))}


def _quadrant(bearing: float) -> str:
    return "n" if bearing >= 315 or bearing < 45 else "e" if bearing < 135 else "s" if bearing < 225 else "w"


# ------------------------------------------------------------------ features
def stamp_of(t: datetime) -> str:
    return t.strftime("%Y%m%d_%H%M")


def latest_scan_time(t_utc: datetime) -> datetime:
    """Start time of the newest scan that is online at t (scan start + LAG_MIN <= t)."""
    s = t_utc - timedelta(minutes=LAG_MIN)
    return s.replace(minute=s.minute - s.minute % 10, second=0, microsecond=0)


def features_at(t_local: datetime, scans: dict, wind_dir: float | None, wv: dict, motion: dict | None = None) -> dict | None:
    """Satellite inputs for the 15-minute step t (Asia/Manila, naive), from band-13 scans {stamp: stats}
    and band-10 (water vapour) scans wv {stamp: stats}.

    motion {stamp: motion_stats() or {} when the earlier scan was missing} adds MOTION_FEATURES for the
    scan used: {} = persistence (no motion, the campus values); a stamp not in motion at all (history not
    downloaded) = persistence with sat_motion_missing = 1. Without motion (None) they are left out.

    Uses the newest band-13 scan online at t, if it is at most MAX_AGE_MIN old, and band 10 of that same
    scan; None = satellite missing (either band). A missing earlier scan makes its cloud-top change 0.
    MUST be the only implementation: training (common.build_sat_features) and live both call it.
    """
    t_utc = t_local - timedelta(hours=8)
    first = latest_scan_time(t_utc)
    s = None
    for back in range(0, MAX_AGE_MIN + 1, 10):
        cand = first - timedelta(minutes=back)
        if (t_utc - cand).total_seconds() / 60 > MAX_AGE_MIN:
            break
        if stamp_of(cand) in scans:
            s = cand
            break
    if s is None or stamp_of(s) not in wv:
        return None
    now, water = scans[stamp_of(s)], wv[stamp_of(s)]
    m10 = scans.get(stamp_of(s - timedelta(minutes=10)))
    m20 = scans.get(stamp_of(s - timedelta(minutes=COOLING_MIN)))

    def change(a: dict | None, b: dict | None, key: str) -> float:
        return float(a[key]) - float(b[key]) if a and b else 0.0

    upwind = now["cold_30km"]
    if wind_dir is not None and not (isinstance(wind_dir, float) and math.isnan(wind_dir)):
        upwind = now[f"cold_{_quadrant(float(wind_dir) % 360)}"]  # wind direction = where it blows FROM
    return {
        "sat_bt_campus": float(now["campus_bt"]),
        "sat_bt_min_10km": float(now["min_10km"]),
        "sat_bt_min_30km": float(now["min_30km"]),
        "sat_cold_10km": float(now["cold_10km"]),
        "sat_cold_30km": float(now["cold_30km"]),
        # Negative = the cloud tops near campus got colder (a cloud growing taller).
        "sat_cooling_20min": change(now, m20, "mean_10km"),
        "sat_upwind_cold": float(upwind),
        "sat_cooling_10min": change(now, m10, "mean_10km"),
        "sat_min_cooling_10min": change(now, m10, "min_10km"),
        # Positive = the tops cooled in BOTH of the last two 10-minute steps (still growing), by at least this much.
        "sat_sustained_cooling": -max(change(now, m10, "mean_10km"), change(m10, m20, "mean_10km")) if m10 and m20 else 0.0,
        "sat_wv_campus": float(water["campus_bt"]),
        # Near 0 (or above) = the cloud over campus reaches the upper air: a deep storm cloud.
        "sat_wv_minus_ir_campus": float(water["campus_bt"]) - float(now["campus_bt"]),
        "sat_wv_minus_ir_10km": float(water["min_10km"]) - float(now["min_10km"]),
        "sat_wv_min_30km": float(water["min_30km"]),
        "sat_age_min": (t_utc - s).total_seconds() / 60.0,
        **({} if motion is None else _motion_features(motion.get(stamp_of(s)), now)),
    }


def _motion_features(m: dict | None, now: dict) -> dict:
    adv_bt = float(m["adv_bt"]) if m else float(now["campus_bt"])
    return {
        "sat_motion_kmh": float(m["speed_kmh"]) if m else 0.0,
        "sat_adv_bt_20min": adv_bt,
        "sat_adv_cold_20min": float(m["adv_cold"]) if m else float(now["cold_10km"]),
        # Negative = a colder (taller) cloud is on its way to campus.
        "sat_adv_minus_campus": adv_bt - float(now["campus_bt"]),
        "sat_motion_missing": 1.0 if m is None else 0.0,
    }


# ------------------------------------------------------------------ live
CACHE = Path(tempfile.gettempdir()) / "arnode_satellite_scans.json"


def _cached() -> dict:
    try:
        return json.loads(CACHE.read_text())
    except (OSError, ValueError):
        return {}


def _cache_key(stamp: str, band: int) -> str:
    return stamp if band == BAND else f"b{band}_{stamp}"


def live(t_local: datetime, wind_dir: float | None, with_motion: bool = False) -> dict:
    """Satellite inputs for step t right now: the newest online band-13 scan, the band-13 scans 10 and
    20 minutes before it, and band 10 of the newest scan (downloaded in parallel). with_motion adds the
    cloud-motion inputs, which need the pixels of the newest scan and the one 10 minutes before it."""
    cache = _cached()

    def get(job: tuple[str, int, bool]) -> dict | None:
        stamp, band, box = job
        try:
            hit = cache.get(_cache_key(stamp, band))
            # A cached scan has no box (the cache keeps numbers only): download again when motion needs it.
            return hit if hit and not box else scan_stats(stamp, band, keep_box=box)
        except (ScanMissing, ValueError):
            return None  # an earlier scan missing: its change counts as 0, as in training

    # All four images at once (the newest scan is almost always online, so this rarely wastes a download).
    fetched: dict[str, dict] = {}
    first = latest_scan_time(t_local - timedelta(hours=8))
    found = None
    for back in range(0, MAX_AGE_MIN + 1, 10):
        s = first - timedelta(minutes=back)
        jobs = [(stamp_of(s - timedelta(minutes=m)), BAND, with_motion and m in (0, 10)) for m in (0, 10, COOLING_MIN)]
        jobs.append((stamp_of(s), WV_BAND, False))
        with ThreadPoolExecutor(len(jobs)) as pool:
            results = list(pool.map(get, jobs))
        if results[0] is None:
            continue
        found = stamp_of(s)
        newest, before = results[0], results[1]
        motion = {found: motion_stats(newest, before) if before and "box" in before else {}} if with_motion else None
        fetched = {_cache_key(stamp, band): {k: v for k, v in r.items() if k not in ("box", "geometry")}
                   for (stamp, band, _), r in zip(jobs, results) if r is not None}
        break
    if found is None:
        return {"ok": False, "error": "no satellite scan online in the last {} minutes".format(MAX_AGE_MIN)}
    scans = {k: v for k, v in fetched.items() if not k.startswith("b")}
    wv = {k[len(f"b{WV_BAND}_"):]: v for k, v in fetched.items() if k.startswith(f"b{WV_BAND}_")}
    feats = features_at(t_local, scans, wind_dir, wv, motion)
    keep = {k: v for k, v in sorted({**cache, **fetched}.items(), key=lambda kv: kv[0][-13:])[-16:]}
    try:
        CACHE.write_text(json.dumps(keep))
    except OSError:
        pass
    if feats is None:
        return {"ok": False, "error": f"no water-vapour (band {WV_BAND}) image for scan {found}" if found not in wv
                else "newest scan is too old"}
    return {"ok": True, "features": feats, "scans": [found, *sorted(scans.keys() - {found}, reverse=True)],
            "attribution": ATTRIBUTION}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    now = sub.add_parser("now", help="satellite inputs for one 15-minute step, as JSON")
    now.add_argument("--at", help="the step, local Asia/Manila time like 2026-11-13T00:15 (default: latest step)")
    now.add_argument("--wind-dir", type=float, default=None, help="10 m wind direction at that step (degrees)")
    now.add_argument("--motion", action="store_true", help="also the cloud-motion inputs (two more downloads)")
    now.add_argument("--cloud", action="store_true", help="also the cloud-phase inputs (cloud_phase.py, needs h5py)")
    mo = sub.add_parser("motion", help="cloud motion of one scan against the scan 10 minutes earlier, as JSON")
    mo.add_argument("stamp", help="scan start in UTC, YYYYMMDD_HHMM")
    one = sub.add_parser("scan", help="statistics of one scan, as JSON")
    one.add_argument("stamp", help="scan start in UTC, YYYYMMDD_HHMM")
    one.add_argument("--band", type=int, default=BAND, help=f"{BAND} = cloud tops (default), {WV_BAND} = water vapour")
    a = ap.parse_args()
    try:
        if a.cmd == "scan":
            out = {"ok": True, **scan_stats(a.stamp, a.band)}
        elif a.cmd == "motion":
            out = {"ok": True, **scan_motion(a.stamp)}
        else:
            if a.at:
                t = datetime.strptime(a.at, "%Y-%m-%dT%H:%M")
            else:
                n = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=8)
                t = n.replace(minute=n.minute - n.minute % 15, second=0, microsecond=0)
            out = live(t, a.wind_dir, a.motion)
            if a.cloud and out.get("ok"):
                import cloud_phase  # needs h5py; only a model with cloud-phase inputs asks for it
                # No scan online in the last MAX_AGE_MIN minutes comes back as sat_phase_missing = 1, as in training.
                out = {**out, "features": {**out["features"], **cloud_phase.live(t)}}
    except Exception as exc:  # network, parsing: report it, never a traceback (the app reads stdout)
        out = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    sys.stdout.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
