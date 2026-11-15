"""Shared heat-index formula, categories and features for the AR-Node heat model.

The SAME maths exists three times and must stay identical:
  ml/heat_common.py         (this file: training, evaluation, parity fixtures)
  app/Services/HeatIndex.php + app/Services/HeatModel.php   (server)
  src/heatIndex.js          (browser: chip text and categories)
tests/fixtures/heat_index_grid.json (written by train_heat.py) and
ml/heat_model_parity.json let PHPUnit and node:test prove they agree.

Heat index: the US National Weather Service procedure (Rothfusz regression),
https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
  1. Simple formula HI = 0.5 * (T + 61 + (T - 68) * 1.2 + RH * 0.094)   [deg F]
     (this already averages the simple result with the temperature).
  2. If that is 80 F or more, use the full regression instead, then
     - subtract [(13 - RH) / 4] * sqrt[(17 - |T - 95|) / 17] when RH < 13 % and 80 <= T <= 112 F,
     - add      [(RH - 85) / 10] * [(87 - T) / 5]               when RH > 85 % and 80 <= T <= 87 F.

Categories: PAGASA (Philippine weather bureau) heat index levels, in deg C.
The thresholds also live in config/weather.php (heat_categories) for the app.
"""
from __future__ import annotations

import math
import re

import numpy as np
import pandas as pd

from common import DATA, LAT, LON, METAR_CSV, ROOT, TZ  # noqa: F401  (LAT/LON/TZ re-exported for the scripts)

ERA5_CSV = DATA / "heat_era5_hourly.csv"
FORECAST_CSV = DATA / "heat_forecast_hourly.csv"
HEAT_MODEL_JSON = ROOT / "heat_model.json"
HEAT_PARITY_JSON = ROOT / "heat_model_parity.json"
GRID_FIXTURE = ROOT.parent / "tests" / "fixtures" / "heat_index_grid.json"

# Hourly Open-Meteo variables the heat model reads (archive + forecast APIs).
HEAT_VARS = [
    "temperature_2m", "relative_humidity_2m", "dew_point_2m", "cloud_cover",
    "wind_speed_10m", "pressure_msl", "precipitation", "shortwave_radiation",
]

# PAGASA levels (lower bound in deg C, key, label). Below the first: not hazardous.
CATEGORIES = [
    (27.0, "caution", "Caution"),
    (33.0, "extreme_caution", "Extreme caution"),
    (42.0, "danger", "Danger"),
    (52.0, "extreme_danger", "Extreme danger"),
]
CATEGORY_KEYS = ["none"] + [k for _, k, _ in CATEGORIES]


def heat_index_f(t_f: float, rh: float) -> float:
    """NWS heat index in deg F from air temperature (deg F) and relative humidity (%)."""
    hi = 0.5 * (t_f + 61.0 + (t_f - 68.0) * 1.2 + rh * 0.094)
    if hi < 80.0:
        return hi
    hi = (-42.379 + 2.04901523 * t_f + 10.14333127 * rh - 0.22475541 * t_f * rh
          - 0.00683783 * t_f * t_f - 0.05481717 * rh * rh + 0.00122874 * t_f * t_f * rh
          + 0.00085282 * t_f * rh * rh - 0.00000199 * t_f * t_f * rh * rh)
    if rh < 13.0 and 80.0 <= t_f <= 112.0:
        hi -= ((13.0 - rh) / 4.0) * math.sqrt((17.0 - abs(t_f - 95.0)) / 17.0)
    elif rh > 85.0 and 80.0 <= t_f <= 87.0:
        hi += ((rh - 85.0) / 10.0) * ((87.0 - t_f) / 5.0)
    return hi


def heat_index_c(t_c: float, rh: float) -> float:
    """NWS heat index in deg C from air temperature (deg C) and relative humidity (%)."""
    t_f = t_c * 9.0 / 5.0 + 32.0
    return (heat_index_f(t_f, rh) - 32.0) * 5.0 / 9.0


def heat_index_series(t_c: pd.Series, rh: pd.Series) -> pd.Series:
    """Vectorised heat_index_c; NaN where an input is missing."""
    out = np.full(len(t_c), np.nan)
    tv, rv = t_c.to_numpy(dtype=float), rh.to_numpy(dtype=float)
    for i in range(len(out)):
        if not (math.isnan(tv[i]) or math.isnan(rv[i])):
            out[i] = heat_index_c(tv[i], rv[i])
    return pd.Series(out, index=t_c.index)


def category(hi_c: float) -> str:
    """PAGASA category key for a heat index in deg C ('none' below Caution)."""
    key = "none"
    for lower, k, _ in CATEGORIES:
        if hi_c >= lower:
            key = k
    return key


def read_hourly(path) -> pd.DataFrame:
    """CSV with a 'time' column (local Asia/Manila, naive) -> hourly time-indexed frame."""
    df = pd.read_csv(path, parse_dates=["time"])
    return df.drop_duplicates("time").set_index("time").sort_index().asfreq("1h")


def build_heat_features(h: pd.DataFrame) -> pd.DataFrame:
    """One row per hour t, using only information known at t (t-1 h and t-3 h for trends).

    MUST match HeatModel::featuresFromPayload() in app/Services/HeatModel.php.
    """
    h = h.asfreq("1h")
    f = pd.DataFrame(index=h.index)
    temp = h["temperature_2m"]
    rh = h["relative_humidity_2m"]
    hi = heat_index_series(temp, rh)
    f["temp"] = temp
    f["humidity"] = rh
    f["dew_point"] = h["dew_point_2m"]
    f["heat_index"] = hi
    f["temp_change_1h"] = temp - temp.shift(1)
    f["temp_change_3h"] = temp - temp.shift(3)
    f["hi_change_1h"] = hi - hi.shift(1)
    f["hi_change_3h"] = hi - hi.shift(3)
    f["cloud_cover"] = h["cloud_cover"]
    f["wind_speed"] = h["wind_speed_10m"]
    f["pressure"] = h["pressure_msl"]
    f["radiation"] = h["shortwave_radiation"]
    hour = f.index.hour
    f["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
    f["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)
    f["hour2_sin"] = np.sin(4 * np.pi * hour / 24.0)
    f["hour2_cos"] = np.cos(4 * np.pi * hour / 24.0)
    month = f.index.month
    f["month_sin"] = np.sin(2 * np.pi * (month - 1) / 12.0)
    f["month_cos"] = np.cos(2 * np.pi * (month - 1) / 12.0)
    return f


def target(h: pd.DataFrame, hours: int) -> pd.Series:
    """Label: heat index at t + hours, from the (reanalysis) temperature and humidity at that hour."""
    hh = h.asfreq("1h")
    return heat_index_series(hh["temperature_2m"], hh["relative_humidity_2m"]).shift(-hours)


# ------------------------------------------------------------------ airport truth
# Heat mode closes exposed paths at this heat index (= config/weather.php heat_mode_c).
HEAT_MODE_C = 40.0
_TEMP_DEW = re.compile(r"^(M?\d{2})/(M?\d{2})$")


def airport_heat_index(raw) -> float:
    """Heat index (deg C) the airport observed. MUST match Metar::heatIndex() in app/Services/Metar.php,
    which the app's live record uses to score the outlook: the temperature/dew point group of the report
    body (before RMK), Magnus humidity (Alduchov and Eskridge constants), NWS heat index, 0.1 deg C.
    NaN when the report has no such group. METAR rounds both to whole degrees (good to ~0.5 deg C)."""
    if not isinstance(raw, str):
        return float("nan")
    for tok in raw.split():
        if tok == "RMK":
            break
        m = _TEMP_DEW.match(tok)
        if m:
            t, d = (float(v.replace("M", "-")) for v in m.groups())
            sat = lambda x: math.exp(17.625 * x / (243.04 + x))  # noqa: E731
            return round(heat_index_c(t, min(100.0, 100.0 * sat(d) / sat(t))), 1)
    return float("nan")


def airport_hourly(index: pd.DatetimeIndex, path=METAR_CSV, tol_min: int = 15) -> pd.Series:
    """Airport heat index at each hour of index (local naive): the report nearest to it within tol_min."""
    met = pd.read_csv(path, dtype=str)
    t = pd.to_datetime(met["valid"], utc=True).dt.tz_convert(TZ).dt.tz_localize(None).dt.floor("min")
    rep = pd.DataFrame({"time": t.astype("datetime64[ns]"), "hi": met["metar"].map(airport_heat_index)})
    rep = rep.dropna().drop_duplicates("time", keep="last").sort_values("time")
    left = pd.DataFrame({"t": pd.DatetimeIndex(index).astype("datetime64[ns]")})
    out = pd.merge_asof(left, rep, left_on="t", right_on="time", direction="nearest", tolerance=pd.Timedelta(minutes=tol_min))
    return pd.Series(out["hi"].to_numpy(), index=index)
