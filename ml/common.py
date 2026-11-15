"""Shared settings and feature engineering for the AR-Node rain predictor.

IMPORTANT: build_features(), build_obs_features(), build_multimodel_features() and
metar_flags() here and RainModel::featuresFromPayload() / Metar::flags() in
app/Services must stay identical. model_parity.json (written by train.py) lets a
PHPUnit test prove they agree. Change one -> change both.

The satellite inputs are NOT repeated in PHP: build_sat_features() and the app both
call satellite.features_at() (the app runs `python satellite.py now`).
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd

# Campus point = WEATHER_LAT / WEATHER_LNG in .env.example (Zamboanga City).
LAT = 6.913097
LON = 122.062156
TZ = "Asia/Manila"  # UTC+8, no daylight saving

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RAW = DATA / "raw"
REPORTS = ROOT / "reports"
M15_CSV = DATA / "openmeteo_minutely15.csv"
HOURLY_CSV = DATA / "openmeteo_hourly.csv"
METAR_CSV = DATA / "metar.csv"
MULTIMODEL_CSV = DATA / "openmeteo_multimodel_hourly.csv"
SAT_CSV = DATA / "satellite_b13.csv"
SAT_B10_CSV = DATA / "satellite_b10.csv"
MODEL_JSON = ROOT / "model.json"
PARITY_JSON = ROOT / "model_parity.json"

# Open-Meteo variable lists (also used by the PHP side: RainModel::queryParams).
MINUTELY_VARS = [
    "precipitation", "temperature_2m", "relative_humidity_2m", "dew_point_2m",
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "cape", "weather_code",
]
HOURLY_VARS = ["pressure_msl", "cloud_cover", "precipitation_probability", "precipitation"]

# Same set as WeatherService::RAIN_CODES.
RAIN_CODES = {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99}

STEP = pd.Timedelta(minutes=15)


def read_series(path: Path) -> pd.DataFrame:
    """CSV with a 'time' column (local Asia/Manila, naive) -> time-indexed frame."""
    df = pd.read_csv(path, parse_dates=["time"])
    df = df.drop_duplicates("time").set_index("time").sort_index()
    return df


def build_features(m15: pd.DataFrame, hourly: pd.DataFrame) -> pd.DataFrame:
    """One row per 15-minute step t, using only information known at t.

    m15    : 15-minute series (precipitation = mm in the PRECEDING 15 min).
    hourly : hourly series (precipitation / probability = PRECEDING hour).
    """
    m = m15.asfreq("15min")
    f = pd.DataFrame(index=m.index)
    p = m["precipitation"]

    f["precip_0"] = p
    f["precip_1"] = p.shift(1)
    f["precip_2"] = p.shift(2)
    f["precip_sum_1h"] = p.rolling(4, min_periods=4).sum()
    f["precip_sum_3h"] = p.rolling(12, min_periods=12).sum()

    code = m["weather_code"]
    f["rain_code_now"] = code.isin(RAIN_CODES).astype(float).where(code.notna())

    temp = m["temperature_2m"]
    f["temp"] = temp
    f["temp_change_1h"] = temp - temp.shift(4)
    f["humidity"] = m["relative_humidity_2m"]
    f["dewpoint_depression"] = temp - m["dew_point_2m"]
    f["wind_speed"] = m["wind_speed_10m"]
    f["wind_gust"] = m["wind_gusts_10m"]
    rad = np.deg2rad(m["wind_direction_10m"])
    f["wind_dir_sin"] = np.sin(rad)
    f["wind_dir_cos"] = np.cos(rad)
    f["cape"] = m["cape"]

    # Hourly values are stamped on the hour; at time t we know the value for
    # floor(t). The forecast for the hour AFTER floor(t) (which contains the
    # 20-minute window) is stamped floor(t)+1h, hence shift(-1).
    h = hourly.asfreq("1h")
    hh = pd.DataFrame(index=h.index)
    hh["pressure"] = h["pressure_msl"]
    hh["pressure_change_3h"] = h["pressure_msl"] - h["pressure_msl"].shift(3)
    hh["cloud_cover"] = h["cloud_cover"]
    hh["precip_prob_next_hour"] = h["precipitation_probability"].shift(-1)
    hh["fcst_precip_next_hour"] = h["precipitation"].shift(-1)
    aligned = hh.reindex(f.index.floor("h"))
    aligned.index = f.index
    f = f.join(aligned)

    hour_frac = f.index.hour + f.index.minute / 60.0
    f["hour_sin"] = np.sin(2 * np.pi * hour_frac / 24.0)
    f["hour_cos"] = np.cos(2 * np.pi * hour_frac / 24.0)
    doy = f.index.dayofyear
    f["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    f["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    return f


# ------------------------------------------------------------ airport reports
# A report is only used once it could have reached the app: aviationweather.gov
# receives RPMZ reports about 9 minutes after the observation time.
OBS_LAG_MIN = 10
# Older than this = "no recent report": every flag 0 and the age capped here.
OBS_MAX_AGE_MIN = 240
# obs_rain_fresh fades from 1 (brand-new report) to 0 at this age.
OBS_FRESH_MIN = 120
# Window for "rain in any report of the last 2 hours".
OBS_RECENT_MIN = 120

# Two-letter METAR weather codes (descriptors and phenomena, plus the VC/RE prefixes).
WX_CHUNKS = {"VC", "RE", "MI", "PR", "BC", "DR", "BL", "SH", "TS", "FZ", "DZ", "RA", "SN", "SG", "IC", "PL",
             "GR", "GS", "UP", "BR", "FG", "FU", "VA", "DU", "SA", "HZ", "PY", "PO", "SQ", "FC", "SS", "DS"}
RAIN_CHUNKS = {"RA", "DZ", "SH", "TS", "UP"}
CONVECTIVE_CLOUD = re.compile(r"^(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)$")
OBS_FLAGS = ["rain", "thunder", "vicinity", "convective_cloud", "lightning", "recent_rain"]
OBS_FEATURES = ["obs_rain", "obs_rain_fresh", "obs_rain_2h", "obs_thunder", "obs_vicinity",
                "obs_convective_cloud", "obs_lightning", "obs_recent_rain", "obs_age_min"]


def _wx_chunks(token: str) -> list[str] | None:
    """Split a present-weather group such as '-TSRA' or 'VCSH' into 2-letter codes; None if it is not one."""
    body = token.lstrip("+-")
    if not body or len(body) % 2 or not body.isalpha() or not body.isupper():
        return None
    chunks = [body[i:i + 2] for i in range(0, len(body), 2)]
    return chunks if all(c in WX_CHUNKS for c in chunks) else None


def metar_flags(raw) -> dict[str, float]:
    """Weather flags from one raw METAR/SPECI text. MUST match Metar::flags() in app/Services/Metar.php.

    rain              rain, drizzle, showers or thunderstorm AT the station (not VC/RE)
    thunder           thunderstorm at the station or in the vicinity (TS, VCTS)
    vicinity          showers or thunderstorm in the vicinity (VCSH, VCTS)
    convective_cloud  a cumulonimbus or towering cumulus cloud group (e.g. FEW015CB)
    lightning         'LTG' in the remarks
    recent_rain       rain that ended since the previous report (RERA, RESHRA, RETSRA, ...)

    Weather is read only from the report body: everything from RMK, NOSIG, TEMPO or BECMG on
    is remarks or a forecast trend, not what is happening now.
    """
    out = dict.fromkeys(OBS_FLAGS, 0.0)
    if not isinstance(raw, str):
        return out
    tokens = raw.split()
    stop = next((i for i, tok in enumerate(tokens) if tok in ("RMK", "NOSIG", "TEMPO", "BECMG")), len(tokens))
    remarks = tokens[tokens.index("RMK") + 1:] if "RMK" in tokens else []
    for tok in tokens[:stop]:
        if CONVECTIVE_CLOUD.match(tok):
            out["convective_cloud"] = 1.0
            continue
        chunks = _wx_chunks(tok)
        if chunks is None:
            continue
        prefix = chunks[0] if chunks[0] in ("VC", "RE") else ""
        codes = set(chunks[1:]) if prefix else set(chunks)
        if prefix == "RE":
            if codes & RAIN_CHUNKS:
                out["recent_rain"] = 1.0
        elif prefix == "VC":
            if codes & {"SH", "TS"}:
                out["vicinity"] = 1.0
            if "TS" in codes:
                out["thunder"] = 1.0
        else:
            if codes & RAIN_CHUNKS:
                out["rain"] = 1.0
            if "TS" in codes:
                out["thunder"] = 1.0
    if any("LTG" in tok for tok in remarks):
        out["lightning"] = 1.0
    return out


def metar_reports(times, raws) -> pd.DataFrame:
    """Reports (local naive times + raw text) -> time-sorted frame with one 0/1 column per flag."""
    df = pd.DataFrame([metar_flags(r) for r in raws], columns=OBS_FLAGS)
    df.insert(0, "time", pd.to_datetime(pd.Series(list(times), dtype="object")).dt.floor("min").to_numpy())
    return df.drop_duplicates("time", keep="last").sort_values("time").reset_index(drop=True)


def build_obs_features(index: pd.DatetimeIndex, reports: pd.DataFrame) -> pd.DataFrame:
    """Airport-report features for each time t, using only reports issued at or before t - OBS_LAG_MIN.

    No report within OBS_MAX_AGE_MIN = every flag 0 and obs_age_min = OBS_MAX_AGE_MIN, so the
    model always has a value (a failed report download must not block a prediction).
    MUST match RainModel::observationFeatures() in app/Services/RainModel.php.
    """
    cut = pd.Series((index - pd.Timedelta(minutes=OBS_LAG_MIN)).astype("datetime64[ns]"))
    grid = pd.DataFrame({"t": pd.Series(index.astype("datetime64[ns]")), "cut": cut})
    rep = reports.assign(time=reports["time"].astype("datetime64[ns]")).reset_index(drop=True)
    rep["cum_rain"] = rep["rain"].cumsum()
    last = pd.merge_asof(grid, rep, left_on="cut", right_on="time", direction="backward")
    # Reports in [cut - OBS_RECENT_MIN, cut] = cumulative rain count now minus the count just before the window.
    early = pd.DataFrame({"cut": cut - pd.Timedelta(minutes=OBS_RECENT_MIN) - pd.Timedelta(seconds=1)})
    before = pd.merge_asof(early, rep[["time", "cum_rain"]], left_on="cut", right_on="time", direction="backward")
    age = ((grid["t"] - last["time"]).dt.total_seconds() / 60.0).to_numpy()
    ok = (last["time"].notna() & (age <= OBS_MAX_AGE_MIN)).to_numpy()
    recent = ((last["cum_rain"] - before["cum_rain"].fillna(0)) > 0).to_numpy()
    f = pd.DataFrame(index=index)
    f["obs_rain"] = np.where(ok, last["rain"], 0.0)
    f["obs_rain_fresh"] = np.where(ok, last["rain"] * np.clip(1.0 - age / OBS_FRESH_MIN, 0.0, 1.0), 0.0)
    f["obs_rain_2h"] = np.where(ok & recent, 1.0, 0.0)
    for flag in ("thunder", "vicinity", "convective_cloud", "lightning", "recent_rain"):
        f[f"obs_{flag}"] = np.where(ok, last[flag], 0.0)
    f["obs_age_min"] = np.where(ok, age, float(OBS_MAX_AGE_MIN))
    return f


# --------------------------------------------------------- several forecast models
# Every global model Open-Meteo serves for the campus point (its best_match there = ecmwf_ifs).
MM_MODELS = ["ecmwf_ifs", "ecmwf_ifs025", "gfs_seamless", "icon_seamless", "jma_seamless", "cma_grapes_global",
             "ukmo_global_deterministic_10km", "gem_seamless", "meteofrance_seamless"]
MM_VARS = ["precipitation", "cloud_cover", "weather_code"]
MM_MIN_MODELS = 5          # fewer models answering = feature missing
MM_WET_MM = 0.1
THUNDER_CODES = {95, 96, 99}
MM_FEATURES = ["mm_wet_share", "mm_precip_mean", "mm_cloud_mean", "mm_thunder_share"]


def build_multimodel_features(index: pd.DatetimeIndex, mm: pd.DataFrame) -> pd.DataFrame:
    """Agreement between forecast models for each time t (hourly values, aligned like build_features).

    Rain and weather code: the value stamped floor(t) + 1 h (the hour containing t, like
    fcst_precip_next_hour). Cloud cover: the value stamped floor(t).
    Each feature is missing when fewer than MM_MIN_MODELS models have a value.
    MUST match RainModel::multiModelFeatures() in app/Services/RainModel.php.
    """
    h = mm.asfreq("1h")

    def block(var: str) -> pd.DataFrame:
        return h[[f"{var}_{m}" for m in MM_MODELS if f"{var}_{m}" in h]]

    precip_next = block("precipitation").shift(-1)
    code_next = block("weather_code").shift(-1)
    cloud = block("cloud_cover")

    def share(frame: pd.DataFrame, hit: pd.DataFrame) -> pd.Series:
        n = frame.notna().sum(axis=1)
        return (hit.where(frame.notna()).sum(axis=1) / n).where(n >= MM_MIN_MODELS)

    hh = pd.DataFrame(index=h.index)
    hh["mm_wet_share"] = share(precip_next, (precip_next >= MM_WET_MM).astype(float))
    hh["mm_precip_mean"] = precip_next.mean(axis=1).where(precip_next.notna().sum(axis=1) >= MM_MIN_MODELS)
    hh["mm_cloud_mean"] = cloud.mean(axis=1).where(cloud.notna().sum(axis=1) >= MM_MIN_MODELS)
    hh["mm_thunder_share"] = share(code_next, code_next.isin(THUNDER_CODES).astype(float))
    aligned = hh.reindex(index.floor("h"))
    aligned.index = index
    return aligned


# --------------------------------------------------------- satellite (Himawari bands 13 and 10)
from satellite import COOLING_MIN as SAT_COOLING_MIN, LAG_MIN as SAT_LAG_MIN, MAX_AGE_MIN as SAT_MAX_AGE_MIN  # noqa: E402
from satellite import SAT_FEATURES, STAT_KEYS as SAT_STAT_KEYS, features_at  # noqa: E402,F401


def read_satellite(path: Path = SAT_CSV) -> dict:
    """data/satellite_b13.csv (or satellite_b10.csv) -> {stamp: stats} (scans missing from the archive left out)."""
    df = pd.read_csv(path, dtype={"stamp": str})
    df = df[df["satellite"].notna()].drop_duplicates("stamp", keep="last")
    return {r["stamp"]: r for r in df[["stamp", *SAT_STAT_KEYS]].to_dict("records")}


def build_sat_features(index: pd.DatetimeIndex, scans: dict, wv: dict, wind_dir: pd.Series) -> pd.DataFrame:
    """Satellite inputs for each 15-minute step t (all NaN where no scan is recent enough).

    scans / wv = band-13 / band-10 scans (read_satellite). wind_dir = Open-Meteo 10 m wind direction at t
    (degrees), for the upwind storm-cloud share.
    Same function the app runs live (satellite.features_at), so no separate parity port.
    """
    wind = wind_dir.reindex(index)
    rows = []
    for t in index:
        w = wind.get(t)
        f = features_at(t.to_pydatetime(), scans, None if pd.isna(w) else float(w), wv)
        rows.append(f if f is not None else {k: np.nan for k in SAT_FEATURES})
    return pd.DataFrame(rows, index=index, columns=SAT_FEATURES)


# --------------------------------------------------------- the exported rain model, scored in Python
# Every input is rounded to this many decimals before scoring (training too): PHP and numpy differ in
# the 16th digit (sin, sums in another order), enough to flip a tree split sitting exactly on a value.
INPUT_DECIMALS = 9


def model_logit(m: dict, x: dict) -> float:
    """Log-odds of rain from an exported model (model.json, or its "fallback") for one step's inputs.

    kind "logistic": the standardised weighted sum. kind "trees": gradient-boosted trees, each a flat
    list of nodes (f = feature index or -1 for a leaf, t = threshold, l/r = child nodes, v = leaf value).
    "calibration" {a, b} then rescales the log-odds (Platt). Same maths as RainModel::score() in PHP.
    """
    names = m["features"]
    x = {n: round(float(x[n]), INPUT_DECIMALS) for n in names}
    if m.get("kind") == "trees":
        z = float(m["baseline"])
        for t in m["trees"]:
            i = 0
            while t["f"][i] >= 0:
                i = t["l"][i] if float(x[names[t["f"][i]]]) <= t["t"][i] else t["r"][i]
            z += t["v"][i]
    else:
        z = float(m["intercept"]) + sum(c * (float(x[n]) - mu) / (sc or 1.0)
                                        for n, c, mu, sc in zip(names, m["coef"], m["mean"], m["scale"]))
    cal = m.get("calibration")
    return cal["a"] * z + cal["b"] if cal else z


def model_probability(m: dict, x: dict) -> float:
    return 1.0 / (1.0 + float(np.exp(-model_logit(m, x))))
