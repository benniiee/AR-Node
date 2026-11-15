"""Self-check for satellite.py (no network): the campus pixel and which scan each step uses.

Training and the app share this code, so a mistake here would be wrong in both and no parity
test would notice. Run:  python ml/test_satellite.py
"""
from datetime import datetime

import satellite as s


def stats(mean: float, **cold: float) -> dict:
    base = {k: 0.0 for k in s.STAT_KEYS}
    return {**base, "campus_bt": mean, "mean_10km": mean, "min_10km": mean, "min_30km": mean, **cold}


# Campus on the nominal 2 km grid: segment 5, row 173 in it, column 1749 (checked on real scans 2026-11-12).
col, line = s._project(s.LAT, s.LON, 140.7, 20466275, 20466275, 2750.5, 2750.5, 42164.0, 6378.137, 6356.7523)
assert s._segment() == 5
assert (int(round(line)) - 2201, int(round(col)) - 1) == (173, 1749), (line, col)

step = datetime(2026, 11, 13, 10, 15)  # Manila; 02:15 UTC -> newest scan online started 02:00 (02:00 + 12 min <= 02:15)
assert s.latest_scan_time(datetime(2026, 11, 13, 2, 15)) == datetime(2026, 11, 13, 2, 0)

wv = {k: stats(-45.0) for k in ("20261113_0200", "20261113_0150")}  # band 10 (water vapour)

f = s.features_at(step, {"20261113_0200": stats(-50.0, cold_w=0.8), "20261113_0150": stats(-42.0),
                         "20261113_0140": stats(-30.0)}, 270.0, wv)
assert f["sat_age_min"] == 15.0
assert f["sat_cooling_20min"] == -20.0          # tops 20 C colder than 20 minutes earlier
assert f["sat_cooling_10min"] == -8.0           # ... and 8 C colder than 10 minutes earlier
assert f["sat_sustained_cooling"] == 8.0        # cooled in both 10-minute steps (12 C, then 8 C): at least 8
assert f["sat_upwind_cold"] == 0.8               # wind from the west: the west quarter
assert f["sat_wv_campus"] == -45.0 and f["sat_wv_minus_ir_campus"] == 5.0  # band 10 minus band 13, same scan

f = s.features_at(step, {"20261113_0200": stats(-50.0), "20261113_0150": stats(-55.0), "20261113_0140": stats(-30.0)}, None, wv)
assert f["sat_sustained_cooling"] == -5.0       # warmed in the last step: not a growing cloud

f = s.features_at(step, {"20261113_0200": stats(-50.0)}, None, wv)
assert f["sat_cooling_20min"] == 0.0 and f["sat_cooling_10min"] == 0.0  # earlier scans missing: 0, as in training
assert f["sat_sustained_cooling"] == 0.0

f = s.features_at(step, {"20261113_0150": stats(-10.0)}, None, wv)
assert f["sat_age_min"] == 25.0                  # newest scan missing: the one before it

assert s.features_at(step, {"20261113_0200": stats(-50.0)}, None, {}) is None  # no band 10 for that scan
assert s.features_at(step, {"20261113_0110": stats(-10.0)}, None, wv) is None  # older than MAX_AGE_MIN
assert s.scan_key("20261113_0200", 10)[1].endswith("_B10_FLDK_R20_S0510.DAT.bz2")
assert s._quadrant(0) == "n" and s._quadrant(90) == "e" and s._quadrant(180) == "s" and s._quadrant(300) == "w"
print("satellite self-check passed")
