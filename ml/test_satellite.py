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
# ---- cloud motion: a cold cloud 3 columns east and 2 lines south of where it was 10 minutes earlier
R = 16
geo = {"r": R, "kx": 2.0, "ky": 2.0, "north_sign": -1}


def box_with_cloud(row: int, col: int) -> list:
    return [[-60.0 if abs(i - row) <= 3 and abs(j - col) <= 3 else 25.0 for j in range(-R, R + 1)] for i in range(-R, R + 1)]


before, now = box_with_cloud(-6, -7), box_with_cloud(-4, -4)
m = s.motion_stats({"geometry": geo, "box": now}, {"box": before})
assert (m["shift_e_km"], m["shift_n_km"]) == (6.0, -4.0), m       # 3 columns east, 2 lines south (lines grow south)
assert abs(m["speed_kmh"] - 6 * (6.0 ** 2 + 4.0 ** 2) ** 0.5) < 1e-3
# The cloud over campus in 20 minutes is now 2 shifts upstream, at (-4, -6): inside the cloud.
assert m["adv_bt"] == -60.0 and m["adv_cold"] > 0, m
missed = s.motion_stats({"geometry": geo, "box": box_with_cloud(-4, 4)}, {"box": box_with_cloud(-6, 1)})
assert missed["adv_bt"] == 25.0                                     # same motion, cloud passes east of campus
flat = s.motion_stats({"geometry": geo, "box": box_with_cloud(99, 99)}, {"box": box_with_cloud(99, 99)})
assert flat["speed_kmh"] == 0.0 and flat["adv_bt"] == 25.0       # clear sky: no motion, persistence

one_scan = {"20261113_0200": stats(-50.0)}
f = s.features_at(step, one_scan, None, wv, {"20261113_0200": m})
assert f["sat_adv_bt_20min"] == -60.0 and f["sat_adv_minus_campus"] == -10.0
f = s.features_at(step, one_scan, None, wv, {"20261113_0200": {}})   # earlier scan missing: persistence
assert f["sat_motion_kmh"] == 0.0 and f["sat_adv_bt_20min"] == -50.0 and f["sat_adv_minus_campus"] == 0.0
f = s.features_at(step, one_scan, None, wv, {})                      # not downloaded: unknown
assert all(f[k] != f[k] for k in s.MOTION_FEATURES)                  # NaN
assert not any(k in s.features_at(step, one_scan, None, wv) for k in s.MOTION_FEATURES)  # no motion asked for
# ---- cloud phase: the step uses the newest scan whose phase file is online (scan start + 20 min)
import cloud_phase as cp  # noqa: E402

g = s._geometry(cp.NOMINAL)
assert (g["row"], g["col"]) == (2373, 1749)                          # same campus pixel as the band-13 strip
assert cp.candidates(datetime(2026, 11, 13, 10, 30))[0] == "20261113_0210"   # 02:30 UTC -> the 02:10 scan
assert cp.candidates(datetime(2026, 11, 13, 10, 45))[0] == "20261113_0220"
p = {"water_10km": 0.4, "supercooled_10km": 0.1, "ice_10km": 0.0, "cloudy_30km": 0.6}
assert cp.features_at(datetime(2026, 11, 13, 10, 30), {"20261113_0200": p})["sat_phase_water_10km"] == 0.4  # 02:10 missing: 02:00
assert cp.features_at(datetime(2026, 11, 13, 10, 30), {"20261113_0200": p})["sat_phase_missing"] == 0.0
f = cp.features_at(datetime(2026, 11, 13, 10, 30), {"20261113_0110": p})  # older than MAX_AGE_MIN: an input, not NaN
assert f["sat_phase_missing"] == 1.0 and all(f[k] == 0.0 for k in cp.CLOUD_FEATURES if k != "sat_phase_missing")
print("satellite self-check passed")
