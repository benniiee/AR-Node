"""AR-Node weather models: control panel and evidence dashboard (Tkinter).

Run from the project root (or double-click):

    python ml\\gui.py

Sidebar sections (Ctrl+1 .. Ctrl+8, F5 reloads the files)
  Overview    where both models stand and what to do next
  Data        rain dataset, heat dataset, and raw rows of every file
  Rain model  download + train the 20-minute rain model; scorecard, model, evaluation, live test
  Heat model  download + train the 1-3 hour heat index model; baselines, error per horizon,
              confusion matrix, model
  History     what both models predicted in real life, checked against the airport (php artisan weather:history)
  Results     both models side by side against the simple methods they must beat
  Export      the JSON files the server reads, the parity check, evidence reports
  Logs        live output of every step

Nothing here changes a model by itself: the GUI only runs the existing scripts
(download_openmeteo.py, download_metar.py, train.py, download_heat.py, train_heat.py)
with the settings shown, and reads their outputs. The rain workflow runs exactly the
same commands as before the heat model was added.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tkinter import messagebox, ttk

import numpy as np
import pandas as pd
import requests
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

from common import (HOURLY_CSV, LAT, LON, M15_CSV, METAR_CSV, MM_MODELS, MM_VARS, MODEL_JSON, MULTIMODEL_CSV,
                    OBS_LAG_MIN, OBS_MAX_AGE_MIN, PARITY_JSON, RAIN_CODES, REPORTS, ROOT, SAT_B10_CSV, SAT_CSV, SAT_FEATURES, TZ,
                    build_features, build_multimodel_features, build_obs_features, metar_flags, metar_reports,
                    model_logit, read_series)
import satellite
from download_metar import fetch_year
from heat_common import (HEAT_MODE_C, CATEGORY_KEYS, ERA5_CSV, FORECAST_CSV, GRID_FIXTURE, HEAT_MODEL_JSON, HEAT_PARITY_JSON,
                         HEAT_VARS, add_airport_features, airport_heat_index, build_heat_features, category,
                         heat_index_series, read_hourly)
from train import metar_rain_flag, nearest_obs

MANILA = timezone(timedelta(hours=8))  # Asia/Manila, no daylight saving
EVIDENCE = REPORTS / "evidence"
TRAIN_LOG = REPORTS / "last_train_log.txt"
TRAIN_H60_LOG = REPORTS / "last_train_h60_log.txt"
MODEL_H60_JSON = ROOT / "model_h60.json"
METRICS_JSON = REPORTS / "metrics.json"
HEAT_TRAIN_LOG = REPORTS / "last_heat_train_log.txt"
HEAT_METRICS_JSON = REPORTS / "heat_metrics.json"
PROJECT = ROOT.parent  # the Laravel app (php artisan, node tests)
OPEN_METEO_LIVE = "https://api.open-meteo.com/v1/forecast"
# Open-Meteo's default "best match" at the campus point is ECMWF IFS (checked 2026-11-07: best_match output
# equals models=ecmwf_ifs there). That model's metadata says when Open-Meteo last published a new run.
OPEN_METEO_SOURCE_MODEL = "ECMWF IFS"
OPEN_METEO_META = "https://api.open-meteo.com/data/ecmwf_ifs/static/meta.json"
ATTRIBUTION = ("Weather data by Open-Meteo.com (CC BY 4.0). Observations: METAR via Iowa Environmental Mesonet. "
               "Satellite: Himawari-8/9 by the Japan Meteorological Agency (JMA), distributed by NOAA.")

ACCENT = "#0f766e"
GOOD = "#15803d"
BAD = "#b91c1c"
MUTED = "#6b7280"
GRAY_BAR = "#9ca3af"


# =============================================================== helpers
def fmt(v, nd: int = 4) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "-"
    if isinstance(v, (int, np.integer)):
        return f"{int(v):,}"
    if isinstance(v, (float, np.floating)):
        return f"{v:.{nd}f}"
    return str(v)


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def open_folder(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def read_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def fetch_forecast_run() -> dict:
    """When Open-Meteo last published the forecast model run the live predictions read (Manila time).

    Returns {"run", "published", "next"} datetimes ("next" is the expected next update, may be None),
    or {"error": message}. Never raises: a missing update time must not block a prediction.
    """
    try:
        r = requests.get(OPEN_METEO_META, timeout=15)
        r.raise_for_status()
        js = r.json()
        published = datetime.fromtimestamp(int(js["last_run_availability_time"]), MANILA)
        interval = int(js.get("update_interval_seconds") or 0)
        return {"run": datetime.fromtimestamp(int(js["last_run_initialisation_time"]), MANILA), "published": published,
                "next": published + timedelta(seconds=interval) if interval else None}
    except Exception as exc:  # network, parsing: report it, do not fail the prediction
        return {"error": str(exc)}


def t12(dt, seconds: bool = False) -> str:
    """12-hour clock for display, e.g. '11:58 PM' (files keep 24-hour ISO times)."""
    hour = dt.hour % 12 or 12
    sec = f":{dt.second:02d}" if seconds else ""
    return f"{hour}:{dt.minute:02d}{sec} {'AM' if dt.hour < 12 else 'PM'}"


def dt12(dt, seconds: bool = False) -> str:
    """Date and 12-hour time for display, e.g. '2026-11-07 11:58 PM'."""
    return f"{dt:%Y-%m-%d} {t12(dt, seconds)}"


def forecast_run_text(run: dict | None) -> str:
    """One sentence saying when Open-Meteo last updated its forecast."""
    if not run or "error" in run:
        return "Open-Meteo's last update time could not be fetched."
    published, mins = run["published"], max(0, int((datetime.now(MANILA) - run["published"]).total_seconds() // 60))
    age = f"{mins // 60} h {mins % 60:02d} min ago" if mins >= 60 else f"{mins} min ago"
    nxt = f"; next update expected around {t12(run['next'])}" if run.get("next") else ""
    return (f"Open-Meteo last updated its forecast at {dt12(published)} ({age}; "
            f"{OPEN_METEO_SOURCE_MODEL} run from {t12(run['run'])}){nxt}.")


def forecast_run_short(run: dict | None) -> str:
    """Table cell: the publish time of the forecast run, or '-'."""
    return "-" if not run or "error" in run else dt12(run["published"])


def append_csv_row(path: Path, header: list[str], values: list[str]) -> None:
    """Append one row to a log CSV. A file written before a column was added gets the new header
    (older rows padded with blanks), so the file stays readable as one table."""
    try:
        REPORTS.mkdir(exist_ok=True)
        lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
        old = lines[0].split(",") if lines else []
        if not lines or (old != header and header[:len(old)] == old):
            pad = "," * (len(header) - len(old)) if lines else ""
            body = [ln + pad for ln in lines[1:]]
            path.write_text("\n".join([",".join(header), *body]) + "\n", encoding="utf-8")
        with path.open("a", encoding="utf-8", newline="") as fh:
            fh.write(",".join(values) + "\n")
    except OSError:
        pass


# ============================================================== tooltips
class Tooltip:
    """Hover help. Pass fixed `text`, or `lookup(event) -> str | None` for per-area help
    (notebook tabs, table headings)."""

    def __init__(self, widget, text: str | None = None, lookup=None, delay: int = 450) -> None:
        self.w, self.text, self.lookup, self.delay = widget, text, lookup, delay
        self.tip: tk.Toplevel | None = None
        self.job = None
        self.shown: str | None = None
        widget.bind("<Enter>", self._motion, add="+")
        widget.bind("<Motion>", self._motion, add="+")
        widget.bind("<Leave>", self._hide, add="+")
        widget.bind("<ButtonPress>", self._hide, add="+")

    def _motion(self, e) -> None:
        t = self.lookup(e) if self.lookup else self.text
        if self.tip is not None and t == self.shown:
            return
        self._hide()
        if t:
            self.job = self.w.after(self.delay, lambda: self._show(t, e.x_root, e.y_root))

    def _show(self, t: str, x: int, y: int) -> None:
        self.job = None
        tip = tk.Toplevel(self.w)
        tip.wm_overrideredirect(True)
        tip.wm_geometry(f"+{x + 14}+{y + 18}")
        tk.Label(tip, text=t, justify="left", background="#111827", foreground="white",
                 padx=9, pady=6, wraplength=340).pack()
        self.tip, self.shown = tip, t

    def _hide(self, _e=None) -> None:
        if self.job is not None:
            self.w.after_cancel(self.job)
            self.job = None
        if self.tip is not None:
            self.tip.destroy()
            self.tip = None
        self.shown = None


TIPS = {
    "start": "First day of weather history to download. Older start dates give the model more wet and dry seasons to learn from. Open-Meteo's archive begins around 2022.",
    "station": "The airport weather station that supplies the real 'did it rain?' answers. RPMZ is Zamboanga International Airport, the closest one. These are real observations, but taken at the airport, not on campus.",
    "alert": "How sure the model must be before rain mode switches on. auto (recommended): training picks the value with the best F2 score on the validation period, which counts a caught shower twice as much as an avoided false alarm. A number such as 0.6 means at least 60% sure. Lower catches more rain but gives more false alarms. It does not change the probabilities themselves, so accuracy scores such as Brier and AUC stay the same. The app uses the model's threshold unless WEATHER_MODEL_RAIN_ON is set.",
    "kind": "How the model combines its inputs.\n\nlogistic: one weight per input; steadier on new months, and the live test can show how much each input pushed the chance up or down.\ntrees: gradient-boosted decision trees; can learn combinations of inputs but cannot explain a single prediction.\nauto: logistic unless the trees score at least 0.5% better on the validation months.",
    "b_tr60": "Optional. Train a second model for 'rain at any time in the next 60 minutes' (same inputs, same honest train/validation/test split; any airport report in the hour that says rain counts). Writes model_h60.json; the app shows its chance next to the 20-minute one. Uses the Model type setting; the alert threshold is always chosen automatically.",
    "label": "Where the 'it rained' answers used for training come from.\n\nauto: real airport observations (METAR) if downloaded, otherwise Open-Meteo.\nmetar: always real observations (best truth).\nopenmeteo: Open-Meteo's own model rainfall. Not a measurement, so scores can look better than reality.",
    "b_om": "Step 1. Download weather history for the campus point from Open-Meteo (free, no key): the best-match forecast, then archived forecasts from 9 weather models (from 2024) so the model can use how many of them agree. Safe to repeat: finished chunks are cached.",
    "b_mt": "Step 2. Download real airport observations (METAR). They label when it actually rained, and the latest report before each moment is also an input (only reports at least 10 minutes old, as the app would have them).",
    "b_tr": "Step 3. Train the model on the oldest part of the data, tune on the middle part, and score it once on the newest part it has never seen.",
    "b_all": "Runs steps 1, 2 and 3 in order (not the satellite download, which takes hours).",
    "b_sat": "Optional step. Download Himawari satellite history around campus (JMA via NOAA, free, no account): "
             "cloud tops (band 13, 5 scans per hour) and water vapour (band 10, 2 scans per hour), about 1.1-1.5 MB read "
             "per scan, only 10 numbers kept per scan. From 2024-01-01 that is about 190 GB of downloading and many hours; "
             "it resumes where it stopped. Training then compares the model with and without satellite inputs and only "
             "keeps satellite if it clearly helps.",
    "sat_start": "First day of satellite history to download (UTC). Training only uses the period that has satellite "
                 "inputs AND the 9-model forecasts (from 2024-01-01), so an earlier date only makes the download longer "
                 "(about 6 GB per month).",
    "hist_source": "App (every 20 min): what the app predicted every 20 minutes and the airport's answers, read with 'php artisan weather:history' (needs PHP and the database). This GUI's live runs: only the predictions made with the buttons in this GUI.",
    "obs_buttons": "Tell the model what you see right now. It runs a fresh live prediction and saves your answer with the exact inputs the model saw (ml/reports/rain_observations.csv and live_snapshots.jsonl). These become a campus-level real-world test, and later extra training rows. The model is NOT retrained on the spot.",
    "check_outcomes": "Looks up what the airport actually reported about 20 minutes after each saved live prediction (Iowa Environmental Mesonet archive) and fills it into ml/reports/live_predictions.csv. Predictions less than 45 minutes old wait until their report exists.",
    "b_stop": "Stops the step that is running.",
    "h_view": "Simple: plain-language summaries for presenting. Detailed: every table and chart. Applies to the rain tabs (Rain dataset, Data Preview, Model, Evaluation).",
    "h_refresh": "Reload all files from disk and redraw every tab.",
    "h_export": "Write a Markdown report with charts and file fingerprints to ml/reports/evidence/ for your documentation.",
    "h_folder": "Open the ml folder in your file explorer.",
    "c_train": "How many 15-minute moments the model learned from. Only the oldest part of the data is used for learning.",
    "c_test": "The newest part of the data, kept hidden during training and scored once at the end. This is the fair test of whether the model really predicts rain.",
    "c_auc": "How well the model ranks rainy moments above dry ones. 0.50 is a coin flip, 1.00 is perfect. Good is 0.80 or more, fair is 0.70 to 0.80.",
    "c_rel": "When the model says 'X% chance', does rain really happen about X% of the time? This is the average gap in percentage points (weighted by how often each probability is used). Smaller is better. Good is under 3 points, fair is under 6.",
    "c_raw": "How much smaller the model's probability error is than Open-Meteo's own next-hour rain chance, scored on the same 20-minute question. Open-Meteo's number was not built for 20 minutes, so this favours the model somewhat.",
    "c_recall": "Of all the moments when it really rained, the share the model warned about, using the alert threshold. A lower threshold catches more rain but gives more false alarms.",
    "c_prec": "When the model warned of rain, how often it really rained. The line below shows how often a dry moment triggered a false alarm.",
    "c_live": "The model's answer for right now, using the current Open-Meteo forecast. Press the button below to run it.",
    "go_live": "Downloads the current forecast for the campus point and runs the trained model on it. Needs internet.",
    "go_heat_live": "Downloads the current hourly forecast for the campus point and runs the trained heat model on it, "
                    "exactly as the app's HeatModel.php does. Needs internet.",
    "hl_card": "The trained heat model's heat index for this hour, with its PAGASA category. "
               "Open-Meteo's own forecast heat index for the same hour is shown below it for comparison.",
    "om_updated": f"When Open-Meteo last published a new forecast run ({OPEN_METEO_SOURCE_MODEL}, its best match for the "
                  "campus point), Manila time. Predictions only change when the forecast does, so repeated runs between "
                  "updates give the same answer.",
    "heat_start": "First day of ERA5 history to download (the archive goes back to 1940). At least 5 years is recommended; the archived forecasts used as model inputs always start in 2022.",
    "heat_train_on": "forecast (recommended): learn from archived Open-Meteo forecasts, the same kind of numbers the app receives live.\nera5: learn from ERA5 reanalysis inputs; for comparison only, it inherits the forecast's warm bias once deployed.",
    "b_hdl": "Step 1. Download ERA5 history and archived forecasts for the campus point (free, no key). Finished chunks are cached, so it is safe to repeat.",
    "b_htr": "Step 2. Train one model per horizon (+1, +2, +3 h), tune on the validation year, and score it once on the last 12 months against the simple methods.",
    "b_hall": "Runs steps 1 and 2 in order.",
    "b_parity": "Runs the PHP tests (php artisan test --filter=Parity|HeatIndexTest|HeatModelTest) the JavaScript heat index test (node --test src/heatIndex.test.mjs) and the satellite reader self-check (python ml/test_satellite.py). Needs PHP and Node on PATH.",
    "h_export_heat": "Write a Markdown summary with the heat test tables and two charts to ml/reports/evidence/.",
    "heat_deployable": "Deployable rows use only what the live app can see: the Open-Meteo forecast. The ERA5 rows are a reference: the app never receives ERA5, so they are not a fair baseline. Truth is the heat index the Zamboanga airport (RPMZ) thermometer reported at the target hour (the same numbers the app's live record uses); with --labels era5, ERA5 temperature and humidity instead.",
    "hd_era5": "Hourly ERA5 reanalysis for the campus grid cell (a ~25 km model cell, not a thermometer). Kept for comparison; the labels now come from the airport thermometer (data/metar.csv), because ERA5 smooths out the hot afternoons.",
    "hd_fc": "Archived Open-Meteo forecasts (Historical Forecast API, from 2022). These are the model's inputs, because the live app only receives forecasts.",
    "hd_hi": "NWS heat index computed from ERA5 temperature and humidity, all hours.",
    "hd_cat": "Share of ERA5 hours in each PAGASA category. No Danger hours (42 \u00b0C or more) occur in this history.",
    "how_judged": "How the ratings are judged: ranking quality (AUC) 0.80+ good, 0.70+ fair; reliability gap under 3 points good, under 6 fair. The model counts as 'beating the baselines' only if its Brier score is lower than every simpler method the app could use. Plain accuracy is not shown because it only rains about 5% of the time, so always guessing 'dry' would already score about 95%.",
}

TAB_TIPS = {
    "Scorecard": "One-page summary for reviewers: is the model trained, how accurate is it, and how reliable are its probabilities.",
    "Rain dataset": "What data the rain model learned from: where it comes from, how much there is, and what period it covers.",
    "Heat dataset": "ERA5 history and archived forecasts the heat model learned from.",
    "Baselines": "Every method scored on the test year, per horizon.",
    "Error per horizon": "Average error and RMSE of the model and the simple methods at +1, +2 and +3 hours.",
    "Confusion matrix": "How often each real heat category was predicted as each category.",
    "Data Preview": "Real rows from the downloaded files, as proof the dataset exists.",
    "Model": "What was trained: the settings, how the data was split, and which weather signals matter most.",
    "Evaluation": "How well the model predicts on data it never saw during training, compared with simpler ways of guessing.",
    "Live Test": "Run the model on the current Open-Meteo forecast right now.",
    "Live prediction": "Run the heat model on the current Open-Meteo forecast right now.",
}

EVAL_HEAD_TIPS = {
    "Model": "Which method was scored. The simpler methods are baselines that the trained model should beat.",
    "n": "Number of unseen test moments used for scoring.",
    "Rain rate": "Share of those test moments when it actually rained.",
    "Brier": "Average squared error of the predicted probabilities. 0 is perfect, lower is better.",
    "AUC": "How well rainy moments are ranked above dry ones. 0.5 is a coin flip, 1.0 is perfect.",
    "Precision": "When the model warned of rain (at the alert threshold), the share of warnings that were right.",
    "Recall": "Of all moments when it really rained, the share the model warned about.",
    "False alarm ratio": "Of all warnings, the share that were wrong because it stayed dry.",
    "False pos. rate": "Of all dry moments, the share that triggered a warning anyway.",
    "Rain starts": "Of the moments when rain STARTED (the latest airport report was still dry), the share the model "
                   "warned about. This is the heads-up students need, and the hardest case.",
}

FEATURE_HEAD_TIPS = {
    "Feature": "A weather signal the model looks at.",
    "Weight": "How strongly the signal moves the prediction. Positive raises the rain chance, negative lowers it. Compare weights between signals.",
    "Mean": "Average of the signal in the training data, used to standardise it before weighting.",
    "Scale": "Typical spread of the signal in the training data, used to standardise it.",
}

FEATURE_LABELS = {
    "precip_0": "Rain in the last 15 min", "precip_1": "Rain 15-30 min ago", "precip_2": "Rain 30-45 min ago",
    "precip_sum_1h": "Rain total, last hour", "precip_sum_3h": "Rain total, last 3 hours",
    "rain_code_now": "Forecast shows rain now", "temp": "Temperature", "temp_change_1h": "Temperature change, last hour",
    "humidity": "Humidity", "dewpoint_depression": "Air dryness (temp minus dew point)",
    "wind_speed": "Wind speed", "wind_gust": "Wind gusts", "wind_dir_sin": "Wind direction (east-west)",
    "wind_dir_cos": "Wind direction (north-south)", "cape": "Storm energy (CAPE)", "pressure": "Air pressure",
    "pressure_change_3h": "Pressure change, last 3 hours", "cloud_cover": "Cloud cover",
    "precip_prob_next_hour": "Open-Meteo rain chance, next hour", "fcst_precip_next_hour": "Open-Meteo rain amount, next hour",
    "hour_sin": "Time of day (a)", "hour_cos": "Time of day (b)", "doy_sin": "Time of year (a)", "doy_cos": "Time of year (b)",
    "obs_rain": "Airport: raining in latest report", "obs_rain_fresh": "Airport: rain, weighted by report age",
    "obs_rain_2h": "Airport: rain in any report, last 2 h", "obs_thunder": "Airport: thunderstorm (at or near)",
    "obs_vicinity": "Airport: showers/storm nearby", "obs_convective_cloud": "Airport: storm clouds (CB/TCU)",
    "obs_lightning": "Airport: lightning reported", "obs_recent_rain": "Airport: rain just ended",
    "obs_age_min": "Airport: report age (minutes)",
    "mm_wet_share": "Models: share showing rain", "mm_precip_mean": "Models: average rain amount",
    "mm_cloud_mean": "Models: average cloud cover", "mm_thunder_share": "Models: share showing thunder",
    "sat_bt_campus": "Satellite: cloud-top temperature over campus", "sat_bt_min_10km": "Satellite: coldest cloud top, 10 km",
    "sat_bt_min_30km": "Satellite: coldest cloud top, 30 km", "sat_cold_10km": "Satellite: storm-cloud share, 10 km",
    "sat_cold_30km": "Satellite: storm-cloud share, 30 km", "sat_cooling_20min": "Satellite: cloud-top change, last 20 min",
    "sat_upwind_cold": "Satellite: storm clouds upwind", "sat_age_min": "Satellite: scan age (minutes)",
    "sat_cooling_10min": "Satellite: cloud-top change, last 10 min", "sat_min_cooling_10min": "Satellite: coldest top change, 10 min",
    "sat_sustained_cooling": "Satellite: cooling in both 10-min steps", "sat_wv_campus": "Satellite: water-vapour temperature over campus",
    "sat_wv_minus_ir_campus": "Satellite: cloud depth over campus (WV - IR)", "sat_wv_minus_ir_10km": "Satellite: deepest cloud, 10 km (WV - IR)",
    "sat_wv_min_30km": "Satellite: coldest water-vapour, 30 km",
}
OPEN_METEO_MULTI_HOURS = {"past_hours": 2, "forecast_hours": 3}  # = RainModel::multiModelQueryParams()
AVIATION_WEATHER_METAR = "https://aviationweather.gov/api/data/metar"
LIVE_SNAPSHOTS = REPORTS / "live_snapshots.jsonl"
OBSERVATIONS_CSV = REPORTS / "rain_observations.csv"
LIVE_CSV = REPORTS / "live_predictions.csv"
AMBER = "#b45309"


def rate(value, good: float, fair: float, higher_better: bool = True) -> tuple[str, str]:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a", MUTED
    if (value >= good) if higher_better else (value <= good):
        return "Good", GOOD
    if (value >= fair) if higher_better else (value <= fair):
        return "Fair", AMBER
    return "Weak", BAD


def calibration_gap(cal: list[dict]) -> float | None:
    """Average |predicted - observed| over probability bins, weighted by bin size."""
    total = sum(c["n"] for c in cal)
    return sum(c["n"] * abs(c["mean_pred"] - c["observed"]) for c in cal) / total if total else None


def over_warn_note(cal: list[dict]) -> str | None:
    bad = [c for c in cal if c["n"] >= 50 and c["mean_pred"] - c["observed"] >= 0.10]
    if not bad:
        return None
    lo = min(float(c["bin"].split("-")[0]) for c in bad)
    return (f"Above about {lo * 100:.0f}% predicted, rain happened less often than predicted, "
            f"so high percentages run too high.")


# ============================================================ data access
class Dataset:
    """Loads the CSV files that the download scripts produce and summarises them."""

    def __init__(self) -> None:
        self.m15: pd.DataFrame | None = None
        self.hourly: pd.DataFrame | None = None
        self.metar: pd.DataFrame | None = None       # time (Manila, naive), rain 0/1
        self.metar_raw_cols: list[str] = []
        self.load()

    def load(self) -> None:
        self.heat_era5 = read_hourly(ERA5_CSV) if ERA5_CSV.exists() else None
        self.heat_fc = read_hourly(FORECAST_CSV) if FORECAST_CSV.exists() else None
        self.heat_hi_era5 = (heat_index_series(self.heat_era5["temperature_2m"], self.heat_era5["relative_humidity_2m"])
                             if self.heat_era5 is not None else None)
        self.heat_hi_fc = (heat_index_series(self.heat_fc["temperature_2m"], self.heat_fc["relative_humidity_2m"])
                           if self.heat_fc is not None else None)
        self.m15 = read_series(M15_CSV) if M15_CSV.exists() else None
        self.hourly = read_series(HOURLY_CSV) if HOURLY_CSV.exists() else None
        self.metar = None
        if METAR_CSV.exists():
            raw = pd.read_csv(METAR_CSV, dtype={"wxcodes": str})
            self.metar_raw_cols = list(raw.columns)
            t = pd.to_datetime(raw["valid"], utc=True).dt.tz_convert(TZ).dt.tz_localize(None)
            self.metar = pd.DataFrame({"time": t, "rain": raw["wxcodes"].map(metar_rain_flag)}).sort_values("time")

    @staticmethod
    def span(df: pd.DataFrame | None, col: str | None = None) -> str:
        if df is None or df.empty:
            return "-"
        s = df.index if col is None else df[col]
        return f"{s.min():%Y-%m-%d} to {s.max():%Y-%m-%d}"


def read_split_log() -> list[dict]:
    """Split sizes printed by train.py ("train 2024-04-25 -> ... rows=23,645 rain=0.099 months=23")."""
    if not TRAIN_LOG.exists():
        return []
    rx = re.compile(r"^(train|val|test)\s+(\S+) -> (\S+)\s+rows=([\d,]+)\s+rain=([\d.]+)\s+months=(\d+)")
    out = []
    for line in TRAIN_LOG.read_text(encoding="utf-8", errors="replace").splitlines():
        m = rx.match(line.strip())
        if m:
            out.append({"split": m.group(1), "start": m.group(2), "end": m.group(3),
                        "rows": int(m.group(4).replace(",", "")), "rain": float(m.group(5)),
                        "months": int(m.group(6))})
    return out


# ================================================================ charts
def new_fig(w: float = 5.6, h: float = 2.8) -> tuple[Figure, object]:
    fig = Figure(figsize=(w, h), dpi=100, layout="constrained")
    return fig, fig.add_subplot(111)


def empty_fig(msg: str, w: float = 5.6, h: float = 2.8) -> Figure:
    fig, ax = new_fig(w, h)
    ax.axis("off")
    ax.text(0.5, 0.5, msg, ha="center", va="center", color=MUTED, fontsize=10, wrap=True)
    return fig


def _month_ticks(ax, labels: list[str]) -> None:
    step = max(1, len(labels) // 10)
    ax.set_xticks(range(0, len(labels), step))
    ax.set_xticklabels(labels[::step], rotation=45, ha="right", fontsize=8)


def fig_openmeteo_monthly(m15: pd.DataFrame | None) -> Figure:
    if m15 is None or "precipitation" not in m15:
        return empty_fig("No Open-Meteo data yet.\nRun step 1 in the Rain model section.")
    monthly = m15["precipitation"].resample("MS").sum()
    fig, ax = new_fig()
    ax.bar(range(len(monthly)), monthly.values, color=ACCENT)
    _month_ticks(ax, [f"{d:%Y-%m}" for d in monthly.index])
    ax.set_ylabel("mm per month", fontsize=9)
    ax.set_title("Open-Meteo precipitation at the campus point", fontsize=10)
    return fig


def fig_metar_monthly(metar: pd.DataFrame | None) -> Figure:
    if metar is None or metar.empty:
        return empty_fig("No METAR observations yet.\nRun step 2 in the Rain model section.")
    g = metar.set_index("time")["rain"].resample("MS").agg(["mean", "count"])
    g = g[g["count"] > 0]
    fig, ax = new_fig()
    ax.bar(range(len(g)), g["mean"].values * 100, color="#2563eb")
    _month_ticks(ax, [f"{d:%Y-%m}" for d in g.index])
    ax.set_ylabel("% of reports with rain", fontsize=9)
    ax.set_title(f"Real airport observations: share of rainy reports ({len(metar):,} reports)", fontsize=10)
    return fig


def exported_result(results: dict) -> dict:
    """The exported model's test row (named "logistic_regression (exported)" in older metrics.json files)."""
    return results.get("exported model") or results["logistic_regression (exported)"]


# The model's fields that turn inputs into a score; a fallback brings its own (never the main model's trees).
SCORING_KEYS = ("kind", "features", "mean", "scale", "coef", "intercept", "C", "baseline", "trees", "tree_params", "calibration", "importance")


def signal_weights(model: dict) -> tuple[np.ndarray, bool]:
    """Per-input weights to chart: the logistic weights (signed), or for trees how much the validation
    Brier worsens when that input is shuffled (unsigned importance)."""
    if "coef" in model:
        return np.array(model["coef"]), True
    return np.array(model.get("importance") or [0.0] * len(model["features"])), False


def fig_coefficients(model: dict | None) -> Figure:
    if not model:
        return empty_fig("No trained model yet.\nRun step 3 in the Rain model section.", 5.6, 4.4)
    names = model["features"]
    coef, signed = signal_weights(model)
    order = np.argsort(np.abs(coef))
    fig, ax = new_fig(5.6, 4.6)
    ax.barh([names[i] for i in order], coef[order], color=[(GOOD if coef[i] > 0 else BAD) if signed else ACCENT for i in order])
    ax.axvline(0, color="black", linewidth=0.8)
    ax.tick_params(axis="y", labelsize=8)
    ax.set_xlabel("weight on standardised feature (green raises rain probability)" if signed
                  else "importance: how much worse the predictions get without it", fontsize=8)
    ax.set_title("What the model uses", fontsize=10)
    return fig


def fig_brier(metrics: dict | None) -> Figure:
    if not metrics:
        return empty_fig("No evaluation yet.\nRun step 3 in the Rain model section.", 5.6, 3.2)
    res = {k: v["brier"] for k, v in metrics["results"].items()}
    items = sorted(res.items(), key=lambda kv: kv[1], reverse=True)
    fig, ax = new_fig(5.6, 3.2)
    colors = [ACCENT if k.startswith("logistic") else GRAY_BAR for k, _ in items]
    ax.barh([k for k, _ in items], [v for _, v in items], color=colors)
    for i, (_, v) in enumerate(items):
        ax.text(v, i, f" {v:.4f}", va="center", fontsize=8)
    ax.tick_params(axis="y", labelsize=8)
    ax.set_xlabel("Brier score on the test period (lower is better)", fontsize=8)
    ax.set_title("Model vs baselines", fontsize=10)
    ax.set_xlim(0, max(v for _, v in items) * 1.18)
    return fig


def fig_calibration(metrics: dict | None) -> Figure:
    if not metrics or not metrics.get("calibration"):
        return empty_fig("No calibration data yet.", 4.2, 3.2)
    cal = metrics["calibration"]
    fig, ax = new_fig(4.2, 3.2)
    ax.plot([0, 1], [0, 1], "--", color=GRAY_BAR, label="perfect")
    ax.plot([c["mean_pred"] for c in cal], [c["observed"] for c in cal], "o-", color=ACCENT, label="model")
    ax.set_xlabel("predicted probability", fontsize=8)
    ax.set_ylabel("observed rain rate", fontsize=8)
    ax.set_title("Calibration (test period)", fontsize=10)
    ax.legend(fontsize=8)
    return fig


def fig_top_signals(model: dict | None, top: int = 6) -> Figure:
    if not model:
        return empty_fig("No trained model yet.", 5.6, 3.0)
    names = model["features"]
    coef, signed = signal_weights(model)
    order = np.argsort(np.abs(coef))[-top:]
    fig, ax = new_fig(5.6, 3.0)
    ax.barh([FEATURE_LABELS.get(names[i], names[i]) for i in order], coef[order],
            color=[(GOOD if coef[i] > 0 else BAD) if signed else ACCENT for i in order])
    ax.axvline(0, color="black", linewidth=0.8)
    ax.tick_params(axis="y", labelsize=8)
    ax.set_xlabel("green raises the rain chance, red lowers it" if signed
                  else "how much worse the predictions get without each signal", fontsize=8)
    ax.set_title("Weather signals that matter most", fontsize=10)
    return fig


def fig_compare(metrics: dict | None) -> Figure:
    if not metrics:
        return empty_fig("No evaluation yet.", 5.6, 3.0)
    res = metrics["results"]
    lr = exported_result(res)
    items = [("Our trained model", lr["brier"], ACCENT)]
    if "raw Open-Meteo probability" in res:
        items.append(("Open-Meteo's own rain chance", res["raw Open-Meteo probability"]["brier"], GRAY_BAR))
    rr = lr["rain_rate"]
    items.append(("Always guess the average", rr * (1 - rr), GRAY_BAR))
    fig, ax = new_fig(5.6, 3.0)
    ax.barh([n for n, _, _ in items][::-1], [v for _, v, _ in items][::-1], color=[c for _, _, c in items][::-1])
    for i, (_, v, _) in enumerate(items[::-1]):
        ax.text(v, i, f" {v:.3f}", va="center", fontsize=9)
    ax.set_xlim(0, max(v for _, v, _ in items) * 1.2)
    ax.tick_params(axis="y", labelsize=9)
    ax.set_xlabel("probability error on unseen data (shorter bar is better)", fontsize=8)
    ax.set_title("Prediction error compared with simpler methods", fontsize=10)
    return fig


class ChartPanel(ttk.Frame):
    """A frame that shows one matplotlib Figure and can swap it for another."""

    def __init__(self, parent, height: int | None = None) -> None:
        super().__init__(parent)
        self._canvas: FigureCanvasTkAgg | None = None
        self._fit_job = None
        if height:
            self.configure(height=height)
            self.pack_propagate(False)

    def show(self, fig: Figure) -> None:
        if self._canvas is not None:
            self._canvas.get_tk_widget().destroy()
        self._canvas = FigureCanvasTkAgg(fig, master=self)
        self._canvas.draw()
        widget = self._canvas.get_tk_widget()
        widget.pack(fill="both", expand=True)
        widget.bind("<Configure>", lambda _e: self._schedule_fit(), add="+")
        self._schedule_fit()

    def _schedule_fit(self) -> None:
        if self._fit_job is not None:
            self.after_cancel(self._fit_job)
        self._fit_job = self.after(80, self._fit)

    def _fit(self) -> None:
        """Match the figure to its widget. With display scaling other than 100% the Tk backend can
        leave the figure a few percent larger than the widget, which clips the bottom of the chart."""
        self._fit_job = None
        c = self._canvas
        if c is None:
            return
        w = c.get_tk_widget()
        width, height = w.winfo_width(), w.winfo_height()
        if width > 1 and height > 1:
            dpi = c.figure.dpi
            size = c.figure.get_size_inches()
            if abs(size[0] * dpi - width) > 1 or abs(size[1] * dpi - height) > 1:
                c.figure.set_size_inches(width / dpi, height / dpi, forward=False)
                c.draw_idle()


# ================================================================ widgets
class StatCard(ttk.Frame):
    def __init__(self, parent, title: str, tip: str | None = None) -> None:
        super().__init__(parent, style="Card.TFrame", padding=(14, 10))
        ttk.Label(self, text=title + ("  \u24d8" if tip else ""), style="CardTitle.TLabel").pack(anchor="w")
        self.value = ttk.Label(self, text="-", style="CardValue.TLabel")
        self.value.pack(anchor="w")
        self.sub = ttk.Label(self, text="", style="CardSub.TLabel", wraplength=250, justify="left")
        self.sub.pack(anchor="w")
        if tip:
            for w in (self, *self.winfo_children()):
                Tooltip(w, tip)

    def set(self, value: str, sub: str = "", color: str | None = None) -> None:
        self.value.config(text=value, foreground=color or "#111827")
        self.sub.config(text=sub)


def make_tree(parent, columns: list[tuple[str, int, str]], height: int = 8,
              heading_tips: dict[str, str] | None = None) -> ttk.Treeview:
    """columns = [(heading, width, anchor)]; returns a Treeview with scrollbars."""
    wrap = ttk.Frame(parent)
    wrap.rowconfigure(0, weight=1)
    wrap.columnconfigure(0, weight=1)
    tree = ttk.Treeview(wrap, columns=[c[0] for c in columns], show="headings", height=height)
    for name, width, anchor in columns:
        tree.heading(name, text=name)
        tree.column(name, width=width, anchor=anchor, stretch=True)
    ys = ttk.Scrollbar(wrap, orient="vertical", command=tree.yview)
    xs = ttk.Scrollbar(wrap, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=ys.set, xscrollcommand=xs.set)
    tree.grid(row=0, column=0, sticky="nsew")
    ys.grid(row=0, column=1, sticky="ns")
    xs.grid(row=1, column=0, sticky="ew")
    tree.container = wrap  # type: ignore[attr-defined]
    if heading_tips:
        def look(e):
            if tree.identify_region(e.x, e.y) != "heading":
                return None
            try:
                return heading_tips.get(columns[int(tree.identify_column(e.x)[1:]) - 1][0])
            except (ValueError, IndexError):
                return None
        Tooltip(tree, lookup=look)
    return tree


def fill_tree(tree: ttk.Treeview, rows: list[tuple]) -> None:
    tree.delete(*tree.get_children())
    for r in rows:
        tree.insert("", "end", values=r)


# ============================================================ heat views
SECTIONS = [("overview", "Overview"), ("data", "Data"), ("rain", "Rain model"), ("heat", "Heat model"),
            ("history", "History"), ("results", "Results"), ("export", "Export"), ("logs", "Logs")]
SECTION_TIPS = {
    "overview": "Where both models stand, and what to do next.",
    "data": "The downloaded history each model learned from, with charts and raw rows.",
    "rain": "Download, train and inspect the 20-minute rain model.",
    "heat": "Download, train and inspect the 1-3 hour heat index model.",
    "history": "What both models predicted in real life over time, checked against the airport reports.",
    "results": "Both models side by side against the simple methods they must beat.",
    "export": "The JSON files the server reads, the parity check, and evidence reports.",
    "logs": "Everything the download, training and test steps print.",
}
HEAT_LABELS = {"none": "Below caution", "caution": "Caution", "extreme_caution": "Extreme caution",
               "danger": "Danger", "extreme_danger": "Extreme danger"}
# Heat mode (config/weather.php heat_mode_c, env WEATHER_HEAT_MODE_C): above this heat index
# now or in the next hour the app closes exposed outdoor paths. WeatherService::resolveHeatMode.
# Same as config/weather.php airport_fresh_minutes: an airport report at most this old decides
# "raining now" in the app; older or missing, Open-Meteo's current reading does.
AIRPORT_FRESH_MIN = 75
HEAT_MODE_C = float(os.environ.get("WEATHER_HEAT_MODE_C", 40))


def heat_mode_on(now: float | None, plus1: float | None) -> bool:
    """Same rule as WeatherService::resolveHeatMode: ABOVE the limit now, or in the next hour."""
    return (now is not None and now > HEAT_MODE_C) or (plus1 is not None and plus1 > HEAT_MODE_C)


HEAT_MODEL_KEY = "model (forecast inputs = deployed)"
HEAT_DEPLOYABLE = {HEAT_MODEL_KEY, "persistence (forecast now)", "diurnal average", "forecast HI at target hour"}
HEAT_METHOD_NAMES = {HEAT_MODEL_KEY: "Trained model", "persistence (forecast now)": "Heat index now (no change)",
                     "diurnal average": "Usual for that month and hour", "forecast HI at target hour": "Forecast heat index",
                     "model (ERA5 inputs)": "Trained model, ERA5 inputs", "persistence (ERA5 now)": "ERA5 heat index now"}
HEAT_HEAD_TIPS = {
    "Horizon": "How far ahead the prediction is: 1, 2 or 3 hours after the current hour.",
    "Method": "The trained model or one of the simple methods it must beat.",
    "Deployable": "Whether the live app could actually compute this. ERA5 rows are reference only: the app never sees ERA5.",
    "n": "Number of test hours scored.",
    "MAE °C": "Average size of the error in °C. Lower is better.",
    "RMSE °C": "Like MAE but large misses count more. Lower is better.",
    "Bias °C": "Average error with its sign: positive means it predicts too hot.",
    "Category accuracy": "Share of hours where the predicted PAGASA category (Caution, Extreme caution, ...) was right.",
}
HEAT_FEATURE_LABELS = {
    "temp": "Temperature", "humidity": "Humidity", "dew_point": "Dew point", "heat_index": "Heat index now",
    "temp_change_1h": "Temperature change, last hour", "temp_change_3h": "Temperature change, last 3 hours",
    "hi_change_1h": "Heat index change, last hour", "hi_change_3h": "Heat index change, last 3 hours",
    "cloud_cover": "Cloud cover", "wind_speed": "Wind speed", "pressure": "Air pressure", "radiation": "Sunshine (radiation)",
    "hour_sin": "Time of day (a)", "hour_cos": "Time of day (b)", "hour2_sin": "Time of day (c)", "hour2_cos": "Time of day (d)",
    "month_sin": "Time of year (a)", "month_cos": "Time of year (b)",
}


def heat_result_rows(hx: dict | None) -> list[tuple]:
    """Per horizon: model MAE, best simple (deployable) method and its MAE, category accuracy."""
    rows = []
    for h, v in (hx or {}).get("horizons", {}).items():
        res = v["results"]
        model = res.get(v.get("deployed_key", HEAT_MODEL_KEY))
        if not model:
            continue
        base = [(k, r["mae"]) for k, r in res.items() if k in HEAT_DEPLOYABLE and k != HEAT_MODEL_KEY and r.get("mae") is not None]
        best = min(base, key=lambda kv: kv[1]) if base else (None, None)
        rows.append((f"+{h} h", f"{model['mae']:.2f}", HEAT_METHOD_NAMES.get(best[0], best[0] or "-"),
                     "-" if best[1] is None else f"{best[1]:.2f}", f"{model['category_accuracy'] * 100:.1f}%"))
    return rows


def heat_verdict(hm: dict | None, hx: dict | None) -> tuple[str, str]:
    """Plain-language verdict for the heat model and its colour."""
    if not hm or not hx:
        return "Not trained yet: download the heat data and train it with the buttons in the Heat model section.", MUTED
    rows = heat_result_rows(hx)
    if not rows:
        return "Trained, but the evaluation has no results. Re-run training.", AMBER
    maes = [float(r[1]) for r in rows]
    best = min((r for r in rows if r[3] != "-"), key=lambda r: float(r[3]), default=None)
    danger = " Danger-level heat cannot be judged: there were no Danger hours in the test year."
    if hm.get("recommended"):
        against = f" than the best simple method ({best[2].lower()}, {best[3]} °C)" if best else ""
        return (f"Recommended: at every horizon its average error ({min(maes):.2f}-{max(maes):.2f} °C) is lower"
                f"{against}, so the app uses it.{danger}"), GOOD
    return ("Not recommended: it does not beat every simple method at every horizon, so the app shows the "
            "forecast heat index instead." + danger), AMBER


def danger_note(m: dict) -> str:
    """Danger-and-above recall in words (undefined when the test period has no Danger hours)."""
    conf = m.get("confusion", {})
    ec = conf.get("extreme_caution", {})
    ec_total = sum(ec.values()) if ec else 0
    ec_text = (f" Extreme caution: {ec.get('extreme_caution', 0) / ec_total * 100:.0f}% of {ec_total:,} hours caught."
               if ec_total else "")
    if not m.get("danger_or_above_cases"):
        return ("Danger and above: recall cannot be measured. The test period has no hours at Danger (heat index 42 °C "
                "or more), and the ERA5 history never reaches it at this point, so the model has never seen one." + ec_text)
    hm_text = (f" Heat mode ({HEAT_MODE_C:.0f} °C or more): {m['heat_mode_recall'] * 100:.0f}% of {m['heat_mode_hours']:,} hours "
               f"reached it in the prediction ({m.get('heat_mode_false', 0):,} predicted hours were below it)." if m.get("heat_mode_hours") else "")
    return (f"Danger and above: {m['danger_or_above_recall'] * 100:.0f}% of {m['danger_or_above_cases']:,} hours were "
            f"predicted as Danger or worse." + ec_text + hm_text)


def fig_heat_monthly(hi_era5: pd.Series | None, hi_fc: pd.Series | None) -> Figure:
    if hi_era5 is None:
        return empty_fig("No heat data yet.\nHeat model > 1 Download heat data.")
    fig, ax = new_fig(7.0, 3.0)
    e = hi_era5.resample("MS").agg(["mean", "max"])
    ax.plot(e.index, e["max"], color=ACCENT, linewidth=1.4, label="ERA5 monthly highest")
    ax.plot(e.index, e["mean"], color=ACCENT, linewidth=1, alpha=0.55, label="ERA5 monthly average")
    if hi_fc is not None:
        f = hi_fc.resample("MS").max()
        ax.plot(f.index, f.values, color=AMBER, linewidth=1.2, linestyle="--", label="Archived forecast monthly highest")
    for lo, name in ((27, "Caution"), (33, "Extreme caution"), (42, "Danger")):
        ax.axhline(lo, color=GRAY_BAR, linewidth=0.7, linestyle=":")
        ax.text(e.index[0], lo + 0.2, name, fontsize=7, color=MUTED)
    ax.set_ylabel("heat index °C", fontsize=9)
    ax.set_title("Heat index at the campus point by month", fontsize=10)
    ax.tick_params(labelsize=8)
    ax.legend(fontsize=7, loc="lower right")
    return fig


def fig_heat_errors(hx: dict | None, compact: bool = False) -> Figure:
    if not hx:
        return empty_fig("No heat evaluation yet.\nHeat model > 2 Train and evaluate.")
    methods = [HEAT_MODEL_KEY, "forecast HI at target hour", "persistence (forecast now)", "diurnal average"]
    colors = [ACCENT, "#6b7280", "#9ca3af", "#d1d5db"]
    hs = list(hx["horizons"].keys())
    panels = [("mae", "Average error (MAE)")] if compact else [("mae", "Average error (MAE)"), ("rmse", "RMSE (big misses count more)")]
    fig = Figure(figsize=(5.6 if compact else 8.0, 2.8 if compact else 3.2), dpi=100, layout="constrained")
    width = 0.8 / len(methods)
    for p, (metric, title) in enumerate(panels):
        ax = fig.add_subplot(1, len(panels), p + 1)
        for i, (meth, col) in enumerate(zip(methods, colors)):
            vals = [hx["horizons"][h]["results"].get(meth, {}).get(metric, np.nan) for h in hs]
            ax.bar([j + (i - 1.5) * width for j in range(len(hs))], vals, width, color=col,
                   label=HEAT_METHOD_NAMES.get(meth, meth))
        ax.set_xticks(range(len(hs)))
        ax.set_xticklabels([f"+{h} h" for h in hs], fontsize=8)
        ax.set_ylabel("°C (lower is better)", fontsize=8)
        ax.set_title(title, fontsize=10)
        ax.tick_params(axis="y", labelsize=8)
        if p == 0:
            ax.legend(fontsize=7, loc="upper left")
    return fig


# ============================================================ history views
# Same colours as the admin Weather page (light steps, validated on white): blue = our model,
# orange = Open-Meteo's own number, aqua = what the airport observed.
H_MODEL, H_PROVIDER, H_AIRPORT = "#2a78d6", "#eb6834", "#1baf7a"
H_DRY, H_UNCHECKED, H_GRID = "#9ca3af", "#d1d5db", "#e5e7eb"
HISTORY_PERIODS = {"24 hours": 1, "7 days": 7, "30 days": 30, "90 days": 90}
MAX_JOIN_MINUTES = 75  # a longer gap breaks the line instead of joining across downtime


def _local_times(values) -> pd.DatetimeIndex:
    """ISO times with an offset -> naive Manila times."""
    return pd.DatetimeIndex(pd.to_datetime(pd.Series(list(values)), utc=True).dt.tz_convert(TZ).dt.tz_localize(None))


def _broken(t: pd.DatetimeIndex, v: pd.Series) -> tuple[pd.DatetimeIndex, pd.Series]:
    """Insert NaN after long gaps so matplotlib breaks the line there."""
    v = pd.Series(np.asarray(v, dtype=float), index=t)
    if len(t) < 2:
        return t, v
    gap = pd.Series(t).diff().dt.total_seconds().div(60).to_numpy()
    cut = np.where(gap > MAX_JOIN_MINUTES)[0]
    if not len(cut):
        return t, v
    extra = pd.Series(np.nan, index=t[cut - 1] + pd.Timedelta(minutes=1))
    out = pd.concat([v, extra]).sort_index()
    return pd.DatetimeIndex(out.index), out


def _style_axes(ax) -> None:
    ax.grid(axis="y", color=H_GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color("#9ca3af")
    ax.tick_params(colors="#4b5563", labelsize=8, length=0)


def _time_axis(ax, t: pd.DatetimeIndex) -> None:
    """12-hour clock for a day or less, dates for longer periods."""
    import matplotlib.dates as mdates
    from matplotlib.ticker import FuncFormatter
    span_days = (t.max() - t.min()).total_seconds() / 86400 if len(t) > 1 else 0
    ax.xaxis.set_major_locator(mdates.AutoDateLocator(minticks=3, maxticks=7))
    if span_days <= 1.5:
        ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _p: t12(mdates.num2date(x).replace(tzinfo=None)).replace(":00", "")))
    else:
        ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _p: mdates.num2date(x).strftime("%b %d").replace(" 0", " ")))


def fig_history_rain(summary: dict | None) -> Figure:
    rain = (summary or {}).get("rain") or {}
    series = rain.get("series") or []
    if not series:
        return empty_fig("No rain predictions in this period yet.", 11, 3.3)
    df = pd.DataFrame(series)
    t = _local_times(df["t"])
    fig = Figure(figsize=(11, 3.3), dpi=100)
    ax, hx = fig.subplots(1, 2, gridspec_kw={"width_ratios": [1.6, 1]})
    for key, color, label in (("model", H_MODEL, "Model's chance"), ("provider", H_PROVIDER, "Open-Meteo's chance (next hour)")):
        if df[key].notna().any():
            known = df[key].notna().to_numpy()
            # Faint line through every point (crosses gaps), then the solid line where data is continuous.
            ax.plot(t[known], df[key][known], color=color, linewidth=1, alpha=0.4)
            tt, vv = _broken(t, df[key])
            # Sparse data (live runs pressed by hand) is mostly isolated points: show them as dots too.
            marker = {"marker": "o", "markersize": 3.5} if len(df) < 300 else {}
            ax.plot(tt, vv, color=color, linewidth=1.5, solid_capstyle="round", label=label, **marker)
    outcome = df["outcome"]
    for flag, color, label in ((True, H_AIRPORT, "Airport: rained"), (False, H_DRY, "Airport: dry")):
        hit = outcome.apply(lambda o, f=flag: o is f or o == f if o is not None and not (isinstance(o, float) and np.isnan(o)) else False)
        if hit.any():
            ax.scatter(t[hit.to_numpy()], np.full(int(hit.sum()), -7), marker="|", s=60, linewidths=2, color=color, label=label)
    ax.set_ylim(-13, 102)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_yticklabels(["0%", "25%", "50%", "75%", "100%"])
    _style_axes(ax)
    _time_axis(ax, t)
    ax.set_title("Predicted chance over time (ticks: airport 20 min later)", fontsize=9, loc="left")
    ax.legend(fontsize=7, frameon=False, ncol=4, loc="upper left", bbox_to_anchor=(0, -0.12))

    bins = rain.get("histogram") or []
    x = np.arange(len(bins))
    bottom = np.zeros(len(bins))
    for key, color, label in (("rained", H_AIRPORT, "Rained"), ("dry", H_DRY, "Stayed dry"), ("unchecked", H_UNCHECKED, "Not checked")):
        v = np.array([b.get(key, 0) for b in bins], dtype=float)
        hx.bar(x, v, bottom=bottom, width=0.62, color=color, label=label, edgecolor="white", linewidth=1)
        bottom += v
    hx.set_xticks(np.arange(-0.5, len(bins), 2))
    hx.set_xticklabels([f"{int(b['from'])}%" for b in bins[::2]] + (["100%"] if len(bins) % 2 == 0 else []))
    hx.set_xlim(-0.6, len(bins) - 0.4)
    _style_axes(hx)
    hx.set_title("How often each chance was given (model)", fontsize=9, loc="left")
    hx.legend(fontsize=7, frameon=False, ncol=3, loc="upper left", bbox_to_anchor=(0, -0.12))
    fig.subplots_adjust(left=0.05, right=0.99, top=0.9, bottom=0.25, wspace=0.18)
    return fig


def fig_history_heat(summary: dict | None) -> Figure:
    heat = (summary or {}).get("heat") or {}
    series = heat.get("series") or []
    if not series:
        return empty_fig("No heat predictions in this period yet.", 11, 3.3)
    df = pd.DataFrame(series)
    t = _local_times(df["t"])
    fig = Figure(figsize=(11, 3.3), dpi=100)
    ax, hx = fig.subplots(1, 2, gridspec_kw={"width_ratios": [1.6, 1]})
    for key, color, label in (("model", H_MODEL, "Model"), ("provider", H_PROVIDER, "Open-Meteo's forecast")):
        if df[key].notna().any():
            known = df[key].notna().to_numpy()
            # Faint line through every point (crosses gaps), then the solid line where data is continuous.
            ax.plot(t[known], df[key][known], color=color, linewidth=1, alpha=0.4)
            tt, vv = _broken(t, df[key])
            # Sparse data (live runs pressed by hand) is mostly isolated points: show them as dots too.
            marker = {"marker": "o", "markersize": 3.5} if len(df) < 300 else {}
            ax.plot(tt, vv, color=color, linewidth=1.5, solid_capstyle="round", label=label, **marker)
    if "observed" in df and df["observed"].notna().any():
        ok = df["observed"].notna().to_numpy()
        ax.plot(t[ok], df["observed"][ok], color=H_AIRPORT, linewidth=1, alpha=0.5)
        ax.scatter(t[ok], df["observed"][ok], s=22, color=H_AIRPORT, edgecolors="white", linewidths=1, zorder=3, label="Airport measured")
    _style_axes(ax)
    _time_axis(ax, t)
    from matplotlib.ticker import FuncFormatter, MaxNLocator
    lo, hi = ax.get_ylim()
    ax.yaxis.set_major_locator(MaxNLocator(nbins=5))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:.0f}°" if hi - lo >= 4 else f"{v:.1f}°"))
    ax.set_title("Heat index 1 hour ahead (drawn at the hour it was for)", fontsize=9, loc="left")
    ax.legend(fontsize=7, frameon=False, ncol=3, loc="upper left", bbox_to_anchor=(0, -0.12))

    bins = heat.get("histogram") or []
    if bins and any(b.get("model") or b.get("provider") for b in bins):
        x = np.arange(len(bins))
        w = 0.36
        hx.bar(x - w / 2 - 0.02, [b.get("model", 0) for b in bins], width=w, color=H_MODEL, label="Model")
        hx.bar(x + w / 2 + 0.02, [b.get("provider", 0) for b in bins], width=w, color=H_PROVIDER, label="Open-Meteo")
        edges = [b["from"] for b in bins] + [bins[-1]["to"]]
        hx.set_xticks(np.arange(-0.5, len(bins) + 0.5, 2))
        hx.set_xticklabels([f"{e:+g}".replace("+0", "0").replace("-", "−") for e in edges[::2]])
        hx.legend(fontsize=7, frameon=False, ncol=2, loc="upper left", bbox_to_anchor=(0, -0.12))
    else:
        hx.text(0.5, 0.5, "No airport measurements matched yet.\nThey are filled in after each target hour passes.",
                ha="center", va="center", fontsize=8, color=MUTED, transform=hx.transAxes)
        hx.set_xticks([])
        hx.set_yticks([])
    _style_axes(hx)
    hx.set_title("How far off at +1 h (predicted − measured, °C)", fontsize=9, loc="left")
    fig.subplots_adjust(left=0.05, right=0.99, top=0.9, bottom=0.25, wspace=0.18)
    return fig


def summary_from_local_logs(days: int) -> dict:
    """The History summary built from this GUI's own live runs (when the app has not recorded any)."""
    since = datetime.now(MANILA).replace(tzinfo=None) - timedelta(days=days)
    out = {"count": 0, "source": "gui", "rain": {"series": [], "histogram": [], "stats": {}},
           "heat": {"series": [], "histogram": [], "stats": {"horizons": []}}, "recent": []}
    to_iso = lambda ts: ts.tz_localize(TZ).isoformat()
    if LIVE_CSV.exists():
        df = pd.read_csv(LIVE_CSV, dtype=str, keep_default_na=False)
        df["run"] = pd.to_datetime(df["run_time_manila"], errors="coerce")
        df = df[df["run"] >= since].sort_values("run")
        bins = [{"from": i * 10, "to": i * 10 + 10, "rained": 0, "dry": 0, "unchecked": 0} for i in range(10)]
        series, ys, ps, os_ = [], [], [], []
        for r in df.itertuples():
            p = float(r.model_probability) * 100
            om = float(r.openmeteo_probability) * 100 if r.openmeteo_probability else None
            oc = getattr(r, "airport_outcome", "")
            outcome = True if oc == "1" else False if oc == "0" else None
            series.append({"t": to_iso(r.run), "model": p, "provider": om, "outcome": outcome})
            bins[min(9, int(p // 10))]["unchecked" if outcome is None else "rained" if outcome else "dry"] += 1
            if outcome is not None:
                ys.append(1.0 if outcome else 0.0)
                ps.append(p / 100)
                os_.append(None if om is None else om / 100)
        brier = lambda pr: None if not pr else round(float(np.mean([(a - b) ** 2 for a, b in pr])), 4)
        out["rain"] = {"series": series, "histogram": bins, "stats": {
            "predictions": len(series), "model_predictions": len(series), "checked": len(ys),
            "rain_reports": int(sum(ys)), "brier_model": brier(list(zip(ps, ys))),
            "brier_provider": brier([(o, y) for o, y in zip(os_, ys) if o is not None])}}
        out["count"] = len(series)
    hcsv = REPORTS / "heat_live_predictions.csv"
    if hcsv.exists():
        hd = pd.read_csv(hcsv, dtype=str, keep_default_na=False)
        hd["base"] = pd.to_datetime(hd["base_hour"], errors="coerce")
        hd = hd[pd.to_datetime(hd["run_time_manila"], errors="coerce") >= since].sort_values("base")
        out["heat"]["series"] = [{"t": to_iso(r.base + pd.Timedelta(hours=1)), "model": float(r.model_hi_1h),
                                  "provider": float(r.openmeteo_hi_1h) if r.openmeteo_hi_1h else None, "observed": None}
                                 for r in hd.itertuples()]
    return out


class ScrollFrame(ttk.Frame):
    """A vertically scrollable area: put widgets in `.inner`. The wheel scrolls it unless a table or log is under the pointer."""

    def __init__(self, parent) -> None:
        super().__init__(parent)
        bg = ttk.Style(self).lookup("TFrame", "background") or "#dcdad5"
        self.canvas = tk.Canvas(self, highlightthickness=0, borderwidth=0, background=bg)
        ys = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=ys.set)
        ys.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.inner = ttk.Frame(self.canvas, padding=(0, 0, 12, 12))
        win = self.canvas.create_window(0, 0, window=self.inner, anchor="nw")
        self.inner.bind("<Configure>", lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(win, width=e.width))
        self.bind("<Enter>", lambda _e: self.bind_all("<MouseWheel>", self._wheel), add="+")
        self.bind("<Leave>", lambda _e: self.unbind_all("<MouseWheel>"), add="+")

    def _wheel(self, e) -> None:
        under = self.winfo_containing(e.x_root, e.y_root)
        if isinstance(under, (ttk.Treeview, tk.Text)):
            return
        self.canvas.yview_scroll(int(-e.delta / 120) or (-1 if e.delta > 0 else 1), "units")


# ==================================================================== app
class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("AR-Node weather models - rain and heat")
        self.geometry("1440x900")
        self.minsize(1040, 680)
        self._style()

        self.data = Dataset()
        self.model: dict | None = None
        self.metrics: dict | None = None
        self.heat_model: dict | None = None
        self.heat_metrics: dict | None = None
        self.run_group = "rain"
        self.q: queue.Queue = queue.Queue()
        self.proc: subprocess.Popen | None = None
        self.stop_flag = False
        self.running = False
        self.live_busy = False
        self.heat_live_busy = False
        self.outcome_busy = False
        self.pending_observation: str | None = None

        self.v_view = tk.StringVar(value="simple")
        self._view_frames: list[tuple[ttk.Frame, ttk.Frame]] = []
        self._header()
        ttk.Label(self, text=ATTRIBUTION + " ERA5: Copernicus Climate Change Service.", style="Muted.TLabel"
                  ).pack(side="bottom", anchor="w", padx=14, pady=(0, 8))
        self._nav()
        # Logs first: every other section writes to self.log.
        self._section_logs()
        self._section_overview()
        self._section_data()
        self._section_rain()
        self._section_heat()
        self._section_history()
        self._section_results()
        self._section_export()
        self._apply_view()
        self.show_section("overview")

        self.refresh()
        self.after(100, self._poll)

    # ------------------------------------------------------------ styling
    def _style(self) -> None:
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # crisp text on Windows
        except Exception:
            pass
        s = ttk.Style(self)
        if "clam" in s.theme_names():
            s.theme_use("clam")
        fam = "Segoe UI" if os.name == "nt" else "DejaVu Sans"
        base = (fam, 10)
        self.option_add("*Font", base)
        s.configure("TNotebook.Tab", padding=(14, 6))
        s.configure("Card.TFrame", background="#f3f4f6", relief="flat")
        s.configure("CardTitle.TLabel", background="#f3f4f6", foreground=MUTED, font=(base[0], 9))
        s.configure("CardValue.TLabel", background="#f3f4f6", foreground="#111827", font=(base[0], 20, "bold"))
        s.configure("CardSub.TLabel", background="#f3f4f6", foreground=MUTED, font=(base[0], 9))
        s.configure("Muted.TLabel", foreground=MUTED)
        s.configure("H1.TLabel", font=(base[0], 15, "bold"))
        s.configure("H2.TLabel", font=(base[0], 11, "bold"))
        s.configure("Verdict.TLabel", font=(base[0], 13, "bold"))
        s.configure("Accent.TButton", background=ACCENT, foreground="white", padding=(12, 6))
        s.map("Accent.TButton", background=[("active", "#115e59"), ("disabled", "#9ca3af")])
        s.configure("TButton", padding=(10, 5))
        s.configure("Treeview", rowheight=24)
        side = "#e5e7eb"
        s.configure("Side.TFrame", background=side)
        s.configure("SideHead.TLabel", background=side, foreground=MUTED, font=(base[0], 8, "bold"))
        s.configure("SideNote.TLabel", background=side, foreground=MUTED, font=(base[0], 8))
        s.configure("Nav.TButton", anchor="w", padding=(14, 8), background=side, borderwidth=0, width=16)
        s.map("Nav.TButton", background=[("active", "#d1d5db")])
        s.configure("NavActive.TButton", anchor="w", padding=(14, 8), background=ACCENT, foreground="white", borderwidth=0, width=16)
        s.map("NavActive.TButton", background=[("active", "#115e59")])

    def _header(self) -> None:
        bar = ttk.Frame(self, padding=(14, 12, 14, 8))
        bar.pack(fill="x")
        ttk.Label(bar, text="Weather models: rain and heat", style="H1.TLabel").pack(side="left")
        view = ttk.Frame(bar)
        view.pack(side="left", padx=(24, 0))
        vl = ttk.Label(view, text="View  \u24d8")
        vl.pack(side="left", padx=(0, 6))
        rs = ttk.Radiobutton(view, text="Simple", value="simple", variable=self.v_view, command=self._apply_view)
        rd = ttk.Radiobutton(view, text="Detailed", value="detailed", variable=self.v_view, command=self._apply_view)
        rs.pack(side="left", padx=(0, 6))
        rd.pack(side="left")
        for w in (vl, rs, rd):
            Tooltip(w, TIPS["h_view"])
        b1 = ttk.Button(bar, text="Open ml folder", command=lambda: open_folder(ROOT))
        b3 = ttk.Button(bar, text="Refresh (F5)", command=self.refresh)
        b1.pack(side="right", padx=(6, 0))
        b3.pack(side="right")
        Tooltip(b1, TIPS["h_folder"])
        Tooltip(b3, TIPS["h_refresh"])

    # ----------------------------------------------------------- pipeline
    def _steps(self, keys: list[str]) -> list[dict]:
        py = sys.executable
        start, station = self.v_start.get().strip(), self.v_station.get().strip() or "RPMZ"
        alert = self.v_alert.get().strip() or "auto"
        all_steps = {
            "om": dict(title="Download Open-Meteo", out=M15_CSV,
                       cmd=[py, "-u", "download_openmeteo.py", "--start", start]),
            # Most models are only archived for this point from 2024.
            "mm": dict(title="Download several forecast models", out=MULTIMODEL_CSV,
                       cmd=[py, "-u", "download_multimodel.py", "--start", max(start, "2024-01-01")]),
            "metar": dict(title="Download METAR", out=METAR_CSV,
                          cmd=[py, "-u", "download_metar.py", "--start", start, "--station", station]),
            "sat": dict(title="Download satellite history (Himawari)", out=SAT_CSV,
                        cmd=[py, "-u", "download_satellite.py", "--start", self.v_sat_start.get().strip()]),
            "train": dict(title="Train and evaluate", out=MODEL_JSON, save_log=TRAIN_LOG,
                          cmd=[py, "-u", "train.py", "--alert", alert, "--label", self.v_label.get(),
                               "--station", station, "--kind", self.v_kind.get()]),
            "train60": dict(title="Train the 60-minute model", out=MODEL_H60_JSON, save_log=TRAIN_H60_LOG,
                            cmd=[py, "-u", "train.py", "--horizon", "60", "--within", "--label", "metar",
                                 "--station", station, "--kind", self.v_kind.get()]),
            "heat_dl": dict(title="Download heat data (ERA5 + archived forecasts)", out=ERA5_CSV,
                            cmd=[py, "-u", "download_heat.py", "--start", self.v_heat_start.get().strip()]),
            "heat_train": dict(title="Train and evaluate the heat model", out=HEAT_MODEL_JSON, save_log=HEAT_TRAIN_LOG,
                               cmd=[py, "-u", "train_heat.py", "--train-on", self.v_heat_train_on.get()]),
            "parity_php": dict(title="PHP parity tests", out=None, cwd=PROJECT,
                               cmd=["php", "artisan", "test", "--compact", "--filter=Parity|HeatIndexTest|HeatModelTest"]),
            "parity_js": dict(title="JavaScript heat index test", out=None, cwd=PROJECT,
                              cmd=["node", "--test", "src/heatIndex.test.mjs"]),
            "parity_sat": dict(title="Satellite reader self-check", out=None, cmd=[py, "-u", "test_satellite.py"]),
        }
        return [all_steps[k] for k in keys]

    def _run_buttons(self) -> list[ttk.Button]:
        return [self.btn_om, self.btn_mt, self.btn_sat, self.btn_tr, self.btn_tr60, self.btn_all, self.btn_hdl, self.btn_htr, self.btn_hall,
                self.btn_parity]

    def _group_widgets(self, group: str) -> tuple[ttk.Label, ttk.Progressbar, ttk.Button | None]:
        if group == "heat":
            return self.heat_strip["run_state"], self.heat_strip["progress"], self.btn_hstop
        if group == "export":
            return self.ex_state, self.ex_progress, None
        return self.rain_strip["run_state"], self.rain_strip["progress"], self.btn_stop

    def run(self, keys: list[str]) -> None:
        if self.running:
            messagebox.showinfo("Busy", "Another step is still running. Wait for it to finish or press Stop.")
            return
        group = "heat" if keys[0].startswith("heat") else "export" if keys[0].startswith("parity") else "rain"
        try:
            if group == "rain":
                datetime.strptime(self.v_start.get().strip(), "%Y-%m-%d")
                datetime.strptime(self.v_sat_start.get().strip(), "%Y-%m-%d")
                if self.v_alert.get().strip() != "auto":
                    a = float(self.v_alert.get())
                    assert 0 < a < 1
            elif group == "heat":
                datetime.strptime(self.v_heat_start.get().strip(), "%Y-%m-%d")
        except (ValueError, AssertionError):
            messagebox.showerror("Settings", "Dates must look like 2016-01-01 and the alert threshold must be 'auto' or between 0 and 1.")
            return
        self.running, self.stop_flag, self.run_group = True, False, group
        for b in self._run_buttons():
            b.config(state="disabled")
        label, progress, stop = self._group_widgets(group)
        if stop is not None:
            stop.config(state="normal")
        progress.start(12)
        label.config(text="Running ... (live output in Logs)", foreground=MUTED)
        self._append_log(f"\n{'=' * 60}\n{dt12(datetime.now(), True)}  starting {', '.join(keys)}\n")
        threading.Thread(target=self._worker, args=(self._steps(keys),), daemon=True).start()

    def stop(self) -> None:
        self.stop_flag = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def _worker(self, steps: list[dict]) -> None:
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        success = True
        for st in steps:
            self.q.put(("log", f"\n--- {st['title']} ---\n"))
            t0 = time.time()
            lines: list[str] = []
            try:
                self.proc = subprocess.Popen(st["cmd"], cwd=st.get("cwd", ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                             text=True, encoding="utf-8", errors="replace", env=env, bufsize=1,
                                             creationflags=flags)
                for line in self.proc.stdout:  # type: ignore[union-attr]
                    lines.append(line)
                    self.q.put(("log", line))
                rc = self.proc.wait()
            except OSError as exc:
                self.q.put(("log", f"could not start {st['cmd'][0]}: {exc}\nIs it installed and on PATH?\n"))
                success = False
                break
            if st.get("save_log"):
                REPORTS.mkdir(exist_ok=True)
                st["save_log"].write_text("".join(lines), encoding="utf-8")
            # download_openmeteo.py can crash in its final summary after saving the files,
            # so a fresh output file also counts as success.
            fresh = st["out"] is not None and st["out"].exists() and st["out"].stat().st_mtime >= t0
            if self.stop_flag:
                self.q.put(("log", "\nstopped by user\n"))
                success = False
                break
            if rc != 0 and not fresh:
                self.q.put(("log", f"\nstep failed (exit code {rc}); later steps skipped\n"))
                success = False
                break
            if rc != 0:
                self.q.put(("log", f"\n(exit code {rc}, but the output file was written, continuing)\n"))
        self.q.put(("done", success))

    def _append_log(self, text: str) -> None:
        self.log.config(state="normal")
        self.log.insert("end", text)
        self.log.see("end")
        self.log.config(state="disabled")

    def _poll(self) -> None:
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "log":
                    self._append_log(payload)
                    last = payload.strip()
                    if self.running and last and not last.startswith("---"):
                        self._group_widgets(self.run_group)[0].config(text=last[:180])
                elif kind == "done":
                    self.running = False
                    for b in self._run_buttons():
                        b.config(state="normal")
                    for b in (self.btn_stop, self.btn_hstop):
                        b.config(state="disabled")
                    label, progress, _ = self._group_widgets(self.run_group)
                    progress.stop()
                    if self.run_group == "export":
                        label.config(text=f"Parity check passed at {t12(datetime.now())}: the PHP and JavaScript code match Python."
                                     if payload else "Parity check FAILED or was stopped: see Logs for the failing test.",
                                     foreground=GOOD if payload else BAD)
                    else:
                        label.config(text=(f"Finished at {t12(datetime.now())}" if payload else "Stopped or failed: see Logs"),
                                     foreground=GOOD if payload else BAD)
                    self.refresh()
                elif kind == "live":
                    self._show_live(payload)
                elif kind == "heat_live":
                    self._show_heat_live(payload)
                elif kind == "outcomes":
                    self._show_outcomes(payload)
                elif kind == "history":
                    self._show_history(payload)
        except queue.Empty:
            pass
        self.after(100, self._poll)

    # ------------------------------------------------------------ dataset
    def _tab_dataset(self) -> None:
        tab = ttk.Frame(self.tabs, padding=14)
        self.tabs.add(tab, text="Rain dataset")
        simple, tab = self._split(tab)
        self._build_dataset_simple(simple)
        tab.columnconfigure(0, weight=1, minsize=580)
        tab.columnconfigure(1, weight=1)
        tab.rowconfigure(1, weight=1)

        cards = ttk.Frame(tab)
        cards.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 10))
        self.cards = [StatCard(cards, t) for t in ("Open-Meteo 15-minute rows", "Open-Meteo hourly rows",
                                                   "METAR observations", "Model-ready rows")]
        for i, c in enumerate(self.cards):
            cards.columnconfigure(i, weight=1)
            c.grid(row=0, column=i, sticky="ew", padx=(0 if i == 0 else 8, 0))

        left = ttk.Frame(tab)
        left.grid(row=1, column=0, sticky="nsew", padx=(0, 10))
        left.rowconfigure(1, weight=1)
        left.rowconfigure(3, weight=1)
        left.columnconfigure(0, weight=1)
        ttk.Label(left, text="Files on disk", style="H2.TLabel").grid(row=0, column=0, sticky="w", pady=(0, 4))
        self.files_tree = make_tree(left, [("File", 190, "w"), ("Rows", 90, "e"), ("Date range", 200, "w"),
                                           ("Size", 70, "e")], height=4)
        self.files_tree.container.grid(row=1, column=0, sticky="nsew")  # type: ignore[attr-defined]
        ttk.Label(left, text="Variables and missing values", style="H2.TLabel").grid(row=2, column=0, sticky="w", pady=(10, 4))
        self.cols_tree = make_tree(left, [("File", 90, "w"), ("Variable", 170, "w"), ("Missing", 80, "e")], height=10)
        self.cols_tree.container.grid(row=3, column=0, sticky="nsew")  # type: ignore[attr-defined]

        right = ttk.Frame(tab)
        right.grid(row=1, column=1, sticky="nsew")
        right.columnconfigure(0, weight=1)
        right.rowconfigure((0, 1), weight=1)
        self.chart_om, self.chart_mt = ChartPanel(right), ChartPanel(right)
        self.chart_om.grid(row=0, column=0, sticky="nsew")
        self.chart_mt.grid(row=1, column=0, sticky="nsew", pady=(6, 0))

    # ------------------------------------------------------------ preview
    def _tab_preview(self) -> None:
        tab = ttk.Frame(self.tabs, padding=14)
        self.tabs.add(tab, text="Data Preview")
        simple, tab = self._split(tab)
        self._build_preview_simple(simple)
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(1, weight=1)
        top = ttk.Frame(tab)
        top.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        ttk.Label(top, text="File").pack(side="left")
        self.v_prev = tk.StringVar(value="Open-Meteo 15-minute")
        cb = ttk.Combobox(top, textvariable=self.v_prev, state="readonly", width=26,
                          values=["Open-Meteo 15-minute", "Open-Meteo hourly", "METAR observations",
                                  "Heat: ERA5 hourly", "Heat: archived forecasts"])
        cb.pack(side="left", padx=8)
        cb.bind("<<ComboboxSelected>>", lambda _e: self._fill_preview())
        self.v_prev_mode = tk.StringVar(value="latest")
        ttk.Radiobutton(top, text="Latest 300 rows", value="latest", variable=self.v_prev_mode,
                        command=self._fill_preview).pack(side="left", padx=(12, 4))
        ttk.Radiobutton(top, text="First 300 rows", value="first", variable=self.v_prev_mode,
                        command=self._fill_preview).pack(side="left")
        self.prev_holder = ttk.Frame(tab)
        self.prev_holder.grid(row=1, column=0, sticky="nsew")
        self.prev_holder.rowconfigure(0, weight=1)
        self.prev_holder.columnconfigure(0, weight=1)
        self.prev_tree: ttk.Treeview | None = None

    def _fill_preview(self) -> None:
        name = self.v_prev.get()
        if name.startswith("Open-Meteo 15"):
            df = self.data.m15.reset_index() if self.data.m15 is not None else None
        elif name.startswith("Open-Meteo hourly"):
            df = self.data.hourly.reset_index() if self.data.hourly is not None else None
        elif name.startswith("Heat: ERA5"):
            df = self.data.heat_era5.reset_index() if self.data.heat_era5 is not None else None
        elif name.startswith("Heat: archived"):
            df = self.data.heat_fc.reset_index() if self.data.heat_fc is not None else None
        else:
            df = None
            if METAR_CSV.exists():
                raw = pd.read_csv(METAR_CSV, dtype=str)
                keep = [c for c in ("station", "valid", "tmpf", "dwpf", "relh", "drct", "sknt", "alti", "vsby",
                                    "skyc1", "wxcodes", "metar") if c in raw.columns]
                df = raw[keep or list(raw.columns[:12])]
        if self.prev_tree is not None:
            self.prev_tree.container.destroy()  # type: ignore[attr-defined]
            self.prev_tree = None
        if df is None or df.empty:
            self.prev_tree = make_tree(self.prev_holder, [("Info", 400, "w")], height=5)
            self.prev_tree.container.grid(row=0, column=0, sticky="nsew")  # type: ignore[attr-defined]
            fill_tree(self.prev_tree, [("File not found yet. Download it in the Rain model or Heat model section.",)])
            return
        part = df.tail(300) if self.v_prev_mode.get() == "latest" else df.head(300)
        cols = [(str(c), 110 if str(c) != "metar" else 380, "w") for c in part.columns]
        self.prev_tree = make_tree(self.prev_holder, cols, height=20)
        self.prev_tree.container.grid(row=0, column=0, sticky="nsew")  # type: ignore[attr-defined]
        rows = []
        for rec in part.itertuples(index=False):
            rows.append(tuple("" if (isinstance(v, float) and math.isnan(v)) else
                              (f"{v:.2f}" if isinstance(v, float) else str(v)) for v in rec))
        fill_tree(self.prev_tree, rows)

    # -------------------------------------------------------------- model
    def _tab_model(self) -> None:
        tab = ttk.Frame(self.tabs, padding=14)
        self.tabs.add(tab, text="Model")
        simple, tab = self._split(tab)
        self._build_model_simple(simple)
        tab.columnconfigure(0, weight=1)
        tab.columnconfigure(1, weight=1)
        tab.rowconfigure(0, weight=1)

        left = ttk.Frame(tab)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 10))
        left.columnconfigure(0, weight=1)
        left.rowconfigure((1, 3, 5), weight=1)
        self.model_badge = ttk.Label(left, text="", style="H2.TLabel")
        self.model_badge.grid(row=0, column=0, sticky="w", pady=(0, 4))
        self.info_tree = make_tree(left, [("Setting", 170, "w"), ("Value", 330, "w")], height=9)
        self.info_tree.container.grid(row=1, column=0, sticky="nsew")  # type: ignore[attr-defined]
        ttk.Label(left, text="Training, validation and test periods", style="H2.TLabel").grid(row=2, column=0, sticky="w", pady=(10, 4))
        self.split_tree = make_tree(left, [("Split", 60, "w"), ("From", 90, "w"), ("To", 90, "w"),
                                           ("Rows", 70, "e"), ("Rain rate", 70, "e"), ("Months", 60, "e")], height=3)
        self.split_tree.container.grid(row=3, column=0, sticky="nsew")  # type: ignore[attr-defined]
        ttk.Label(left, text="Features", style="H2.TLabel").grid(row=4, column=0, sticky="w", pady=(10, 4))
        self.feat_tree = make_tree(left, [("Feature", 170, "w"), ("Weight", 80, "e"), ("Mean", 80, "e"), ("Scale", 80, "e")], height=8, heading_tips=FEATURE_HEAD_TIPS)
        self.feat_tree.container.grid(row=5, column=0, sticky="nsew")  # type: ignore[attr-defined]

        self.chart_coef = ChartPanel(tab)
        self.chart_coef.grid(row=0, column=1, sticky="nsew")

    # --------------------------------------------------------- evaluation
    def _tab_eval(self) -> None:
        tab = ttk.Frame(self.tabs, padding=14)
        self.tabs.add(tab, text="Evaluation")
        simple, tab = self._split(tab)
        self._build_eval_simple(simple)
        tab.columnconfigure(0, weight=3)
        tab.columnconfigure(1, weight=2)
        tab.rowconfigure(2, weight=1)
        self.eval_head = ttk.Label(tab, text="", style="H2.TLabel", wraplength=1100, justify="left")
        self.eval_head.grid(row=0, column=0, columnspan=2, sticky="w")
        self.eval_tree = make_tree(tab, [("Model", 230, "w"), ("n", 60, "e"), ("Rain rate", 70, "e"), ("Brier", 70, "e"),
                                         ("AUC", 60, "e"), ("Precision", 70, "e"), ("Recall", 60, "e"), ("Rain starts", 75, "e"),
                                         ("False alarm ratio", 100, "e"), ("False pos. rate", 100, "e")], height=7, heading_tips=EVAL_HEAD_TIPS)
        self.eval_tree.container.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(6, 8))  # type: ignore[attr-defined]
        self.chart_brier, self.chart_cal = ChartPanel(tab), ChartPanel(tab)
        self.chart_brier.grid(row=2, column=0, sticky="nsew", padx=(0, 10))
        self.chart_cal.grid(row=2, column=1, sticky="nsew")
        self.eval_note = ttk.Label(tab, style="Muted.TLabel", wraplength=1100, justify="left", text=(
            "Brier score: mean squared error of the predicted probabilities (0 is perfect). "
            "'variant:' rows are the same model trained on fewer inputs, for comparison; the exported one had the "
            "lowest validation Brier. 'persistence (latest airport report)' = 'it will rain if the last airport "
            "report (at least 10 minutes old) said rain', which the app can do, so the model must beat it."))
        self.eval_note.grid(row=3, column=0, columnspan=2, sticky="w", pady=(6, 0))

    # --------------------------------------------------------------- live
    def _tab_live(self) -> None:
        tab = ttk.Frame(self.tabs, padding=14)
        self.tabs.add(tab, text="Live Test")
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(3, weight=1)
        ttk.Label(tab, style="Muted.TLabel", wraplength=1100, justify="left", text=(
            "Downloads the current Open-Meteo forecast for the campus point, builds the same 24 features the model "
            "was trained on, and scores them with model.json. Needs internet.")).grid(row=0, column=0, sticky="w")
        row = ttk.Frame(tab)
        row.grid(row=1, column=0, sticky="ew", pady=10)
        self.btn_live = ttk.Button(row, text="Fetch live forecast and predict", style="Accent.TButton", command=self.live_predict)
        self.btn_live.pack(side="left")
        self.live_status = ttk.Label(row, text="", style="Muted.TLabel", wraplength=850, justify="left")
        self.live_status.pack(side="left", padx=12)
        self.live_card = StatCard(tab, "Probability of rain in the next 20 minutes")
        self.live_card.grid(row=2, column=0, sticky="w", pady=(0, 10))
        self.live_tree = make_tree(tab, [("Feature", 190, "w"), ("Value", 100, "e"), ("Pushes rain probability", 170, "e")], height=14)
        self.live_tree.container.grid(row=3, column=0, sticky="nsew")  # type: ignore[attr-defined]

    def live_predict(self) -> None:
        if self.live_busy:
            return
        if not self.model:
            self.sc_status.config(text="Train the model first (Rain model section, step 3).", foreground=BAD)
            self.live_status.config(text="Train the model first (Rain model section, step 3).")
            return
        self.live_busy = True
        self.btn_live.config(state="disabled")
        self.sc_btn.config(state="disabled", text="Fetching live forecast ...")
        self.live_status.config(text="Fetching ...")
        self.sc_status.config(text="Contacting Open-Meteo for the current forecast ...", foreground=MUTED)
        self.sc_live.set("...", "fetching the current forecast")
        model = self.model
        threading.Thread(target=lambda: self.q.put(("live", {**self._live_worker(model), "run": fetch_forecast_run()})),
                         daemon=True).start()

    @staticmethod
    def _live_worker(model: dict) -> dict:
        try:
            params = {
                "latitude": LAT, "longitude": LON,
                "minutely_15": "precipitation,temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,"
                               "wind_direction_10m,wind_gusts_10m,cape,weather_code",
                "hourly": "pressure_msl,cloud_cover,precipitation_probability,precipitation",
                "past_minutely_15": 12, "forecast_minutely_15": 4, "past_hours": 4, "forecast_hours": 2,
                # The app's own "raining now" check (WeatherService::buildState) reads these.
                "current": "precipitation,weather_code",
                "timezone": "Asia/Manila",
            }
            r = requests.get(OPEN_METEO_LIVE, params=params, timeout=30)
            r.raise_for_status()
            js = r.json()

            def frame(block: dict) -> pd.DataFrame:
                df = pd.DataFrame(block)
                df["time"] = pd.to_datetime(df["time"])
                return df.drop_duplicates("time").set_index("time").sort_index()

            feats = build_features(frame(js["minutely_15"]), frame(js["hourly"]))
            uses = lambda prefix: any(f.startswith(prefix) for f in model["features"])
            notes = []
            reports = []
            # Same rules as WeatherService: a failed download = "no recent report", not an error.
            station = model.get("observation", {}).get("station", "RPMZ")
            try:
                mr = requests.get(AVIATION_WEATHER_METAR, timeout=20, params={
                    "ids": station, "format": "json",
                    "hours": math.ceil((OBS_MAX_AGE_MIN + OBS_LAG_MIN) / 60) + 1})
                mr.raise_for_status()
                reports = [x for x in mr.json() if isinstance(x, dict) and "obsTime" in x and "rawOb" in x]
            except Exception as exc:
                notes.append(f"airport report unavailable ({exc}), scored as 'no recent report'")
            if uses("obs_"):
                times = [datetime.fromtimestamp(int(x["obsTime"]), MANILA).replace(tzinfo=None) for x in reports]
                feats = feats.join(build_obs_features(feats.index, metar_reports(times, [x["rawOb"] for x in reports])))
            if uses("mm_"):
                mm_cfg = model.get("multi_model", {})
                mr = requests.get(OPEN_METEO_LIVE, timeout=30, params={
                    "latitude": LAT, "longitude": LON, "hourly": ",".join(mm_cfg.get("variables", MM_VARS)),
                    "models": ",".join(mm_cfg.get("models", MM_MODELS)), "timezone": "Asia/Manila", **OPEN_METEO_MULTI_HOURS})
                mr.raise_for_status()
                feats = feats.join(build_multimodel_features(feats.index, frame(mr.json()["hourly"])))
            now = datetime.now(MANILA).replace(tzinfo=None)
            ts = feats.index[feats.index <= now].max()
            scoring, sat_used = model, None
            if uses("sat_"):
                # Exactly what the app runs: python satellite.py now --at <step> --wind-dir <forecast wind>.
                m15_live = frame(js["minutely_15"])
                wind = m15_live["wind_direction_10m"].get(ts) if "wind_direction_10m" in m15_live else None
                sat = satellite.live(ts.to_pydatetime(), None if wind is None or pd.isna(wind) else float(wind))
                if sat.get("ok"):
                    for k, v in sat["features"].items():
                        feats.loc[ts, k] = v
                    sat_used = (sat["scans"][0], sat["features"].get("sat_age_min", 0))
                elif model.get("fallback"):
                    scoring = {**{k: v for k, v in model.items() if k not in SCORING_KEYS}, **model["fallback"]}
                    notes.append(f"satellite unavailable ({sat.get('error')}), scored with the fallback model without it")
                else:
                    return {"error": f"satellite unavailable: {sat.get('error')}"}
            row = feats.loc[ts, scoring["features"]]
            missing = [k for k, v in row.items() if pd.isna(v)]
            if missing:
                return {"error": f"The forecast did not provide: {', '.join(missing)}"}
            latest = max(reports, key=lambda x: int(x["obsTime"]), default=None)
            # Same scorer as training's parity cases (common.model_logit), trees or logistic, calibrated or not.
            z = model_logit(scoring, {k: float(v) for k, v in row.items()})
            contrib = [(name, float(row[name]),
                        scoring["coef"][i] * (float(row[name]) - scoring["mean"][i]) / (scoring["scale"][i] or 1.0) if "coef" in scoring else None)
                       for i, name in enumerate(scoring["features"])]
            raw = float(row["precip_prob_next_hour"]) / 100.0 if "precip_prob_next_hour" in scoring["features"] else None
            if sat_used:
                notes.append(f"satellite scan {sat_used[0]} UTC ({sat_used[1]:.0f} min old) read with satellite.py")
            cur = js.get("current", {})
            return {"prob": 1.0 / (1.0 + math.exp(-z)), "ts": ts, "rows": contrib, "raw": raw, "notes": notes,
                    "thr": float(scoring.get("alert_threshold", model.get("alert_threshold", 0.6))),
                    "metar": None if latest is None else latest["rawOb"],
                    "metar_age_min": None if latest is None else (time.time() - int(latest["obsTime"])) / 60,
                    "now_precip": cur.get("precipitation"), "now_code": cur.get("weather_code")}
        except Exception as exc:  # network, parsing, anything: show it, do not crash the GUI
            return {"error": str(exc)}

    def _show_live(self, res: dict) -> None:
        self.live_busy = False
        self.btn_live.config(state="normal")
        self.sc_btn.config(state="normal", text="Run a live prediction now")
        for b in self.obs_btns:
            b.config(state="normal")
        observed, self.pending_observation = self.pending_observation, None
        if "error" in res:
            msg = f"Failed: {res['error']}. Check your internet connection and try again."
            if observed:
                self._save_observation(datetime.now(MANILA), observed, None)
                msg += f" Your report ('{observed}') was still saved, without the model's inputs."
            self.live_status.config(text=msg)
            self.sc_status.config(text=msg, foreground=BAD)
            self.live_card.set("-", "")
            self.sc_live.set("-", "last attempt failed")
            self._refresh_real_world()
            return
        thr = float(self.model.get("alert_threshold", 0.6)) if self.model else 0.6
        thr = float(res.get("thr", thr))  # the fallback model has its own threshold
        horizon = self.model.get("horizon_minutes", 20) if self.model else 20
        p, raw, ran = res["prob"], res.get("raw"), datetime.now(MANILA)
        on = p >= thr
        state = "RAIN MODE ON" if on else "rain mode off"
        run = res.get("run")
        self.live_card.set(f"{p * 100:.1f}%", f"{state} (alert threshold {thr:.2f}) - forecast step {dt12(res['ts'])} Manila time")
        self.live_status.config(text=f"Updated {t12(ran, True)}. {forecast_run_text(run)}")
        self.sc_live.set(f"{p * 100:.1f}%", f"{state}; run at {t12(ran, True)}", AMBER if on else GOOD)
        raw_txt = f" Open-Meteo's own chance for the next hour: {raw * 100:.0f}%." if raw is not None else ""
        metar_txt = f"\nLatest airport report: {res['metar']}" if res.get("metar") else ""
        notes_txt = "".join(f"\nNote: {n}." for n in res.get("notes", []))
        obs_txt = ""
        if observed:
            said_rain = p >= thr
            agreed = said_rain == (observed == "rain")
            obs_txt = (f"\nYour report '{observed}' was saved. The model {'agreed' if agreed else 'disagreed'} "
                       f"(it said {'rain' if said_rain else 'dry'} at threshold {thr:.2f}).")
        # Same rule as WeatherService: "raining now" forces rain mode on, whatever the 20-minute
        # chance says. A fresh airport report decides it (what was seen); without one, Open-Meteo's
        # current reading does (a model guess, often "drizzle" under a dry sky).
        precip_now, code_now = res.get("now_precip"), res.get("now_code")
        age = res.get("metar_age_min")
        if res.get("metar") and age is not None and -5 <= age <= AIRPORT_FRESH_MIN:
            raining_now = metar_flags(res["metar"])["rain"] > 0
            seen = f"the airport report {age:.0f} min ago {'shows rain' if raining_now else 'shows no rain'}"
        else:
            raining_now = ((precip_now is not None and float(precip_now) >= 0.1)
                           or (code_now is not None and int(code_now) in RAIN_CODES))
            seen = (f"no fresh airport report, so Open-Meteo's current reading decides "
                    f"({precip_now} mm, weather code {code_now}: {'rain' if raining_now else 'no rain'})")
        if raining_now:
            app_txt = f"Raining now: {seen}, so the app's rain mode is ON anyway."
        else:
            app_txt = f"The app's rain mode would be {'ON' if on else 'OFF'} ({seen})."
        self.sc_status.config(
            text=(f"Done at {t12(ran, True)} (Manila time): the model gives a {p * 100:.1f}% chance of rain in the next "
                  f"{horizon} minutes at the campus point ({'above' if on else 'below'} the alert threshold {thr:.2f}). "
                  f"{app_txt}{raw_txt}\n{forecast_run_text(run)}{metar_txt}{notes_txt}{obs_txt}"),
            foreground=AMBER if (on or raining_now) else GOOD)
        self.sc_log.insert("", 0, values=(dt12(ran, True), f"{p * 100:.1f}%",
                                          "-" if raw is None else f"{raw * 100:.0f}%",
                                          "ON" if on else ("ON (raining now)" if raining_now else "off"),
                                          forecast_run_short(run)))
        self._save_live_row(ran, res["ts"], p, raw, thr, on, run)
        snapshot = {"run_time_manila": f"{ran:%Y-%m-%d %H:%M:%S}", "forecast_step": f"{res['ts']:%Y-%m-%d %H:%M}",
                    "model_created": (self.model or {}).get("created"), "probability": round(p, 6),
                    "openmeteo_probability": raw, "alert_threshold": thr, "openmeteo_updated": None if not run or "error" in run else f"{run['published']:%Y-%m-%d %H:%M}",
                    "latest_airport_report": res.get("metar"), "observed": observed,
                    "features": {n: v for n, v, _ in res["rows"]}}
        try:
            REPORTS.mkdir(exist_ok=True)
            with LIVE_SNAPSHOTS.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(snapshot) + "\n")
        except OSError:
            pass
        if observed:
            self._save_observation(ran, observed, {"p": p, "raw": raw, "thr": thr, "step": res["ts"]})
        # Trees have no per-input push: those rows show "-" and are ordered by importance instead.
        imp = dict(zip(self.model["features"], signal_weights(self.model)[0])) if self.model else {}
        rows = sorted(res["rows"], key=lambda r: abs(r[2]) if r[2] is not None else abs(imp.get(r[0], 0.0)), reverse=True)
        fill_tree(self.live_tree, [(FEATURE_LABELS.get(n, n), f"{v:.3f}", "-" if c is None else f"{c:+.3f}") for n, v, c in rows])
        self._refresh_real_world()

    @staticmethod
    def _save_live_row(ran: datetime, step, p: float, raw, thr: float, on: bool, run: dict | None) -> None:
        """Keep every live prediction in ml/reports/live_predictions.csv (the start of a real-world check log).
        airport_outcome is filled in later by 'Check outcomes'."""
        updated = "-" if not run or "error" in run else f"{run['published']:%Y-%m-%d %H:%M}"
        append_csv_row(LIVE_CSV,
                       ["run_time_manila", "forecast_step", "model_probability", "openmeteo_probability", "alert_threshold",
                        "rain_mode", "openmeteo_updated_manila", "airport_outcome"],
                       [f"{ran:%Y-%m-%d %H:%M:%S}", f"{step:%Y-%m-%d %H:%M}", f"{p:.4f}", "" if raw is None else f"{raw:.4f}",
                        str(thr), str(int(on)), "" if updated == "-" else updated, ""])

    # ------------------------------------------------- real-world checking
    def observe(self, what: str) -> None:
        """'It's raining' / 'It's dry': run a fresh live prediction and save the answer with its inputs."""
        if self.live_busy:
            return
        if not self.model:
            self.sc_status.config(text="Train the model first (Rain model section, step 3).", foreground=BAD)
            return
        self.pending_observation = what
        for b in self.obs_btns:
            b.config(state="disabled")
        self.live_predict()

    @staticmethod
    def _save_observation(when: datetime, observed: str, pred: dict | None) -> None:
        """One row per 'It's raining / dry' press. The matching inputs are in live_snapshots.jsonl (same run time)."""
        said = None if pred is None else ("rain" if pred["p"] >= pred["thr"] else "dry")
        append_csv_row(OBSERVATIONS_CSV,
                       ["time_manila", "observed", "forecast_step", "model_probability", "openmeteo_probability",
                        "alert_threshold", "model_said", "model_agreed"],
                       [f"{when:%Y-%m-%d %H:%M:%S}", observed,
                        "" if pred is None else f"{pred['step']:%Y-%m-%d %H:%M}",
                        "" if pred is None else f"{pred['p']:.4f}",
                        "" if pred is None or pred["raw"] is None else f"{pred['raw']:.4f}",
                        "" if pred is None else str(pred["thr"]), said or "",
                        "" if said is None else str(int(said == observed))])

    def check_outcomes(self) -> None:
        if self.outcome_busy:
            return
        self.outcome_busy = True
        self.btn_outcomes.config(state="disabled", text="Checking ...")
        station = (self.model or {}).get("observation", {}).get("station", self.v_station.get().strip() or "RPMZ")
        threading.Thread(target=lambda: self.q.put(("outcomes", self._outcome_worker(station))), daemon=True).start()

    @staticmethod
    def _outcome_worker(station: str) -> dict:
        """Fill airport_outcome in live_predictions.csv: rain (1) or dry (0) in the airport report nearest to
        forecast_step + 20 min (within 15 min) - exactly the training label. 'none' = no report that close."""
        try:
            if not LIVE_CSV.exists():
                return {"filled": 0, "waiting": 0}
            df = pd.read_csv(LIVE_CSV, dtype=str, keep_default_na=False)
            if "airport_outcome" not in df:
                df["airport_outcome"] = ""
            step = pd.to_datetime(df["forecast_step"], errors="coerce")
            now = datetime.now(MANILA).replace(tzinfo=None)
            todo = (df["airport_outcome"] == "") & step.notna() & (step + pd.Timedelta(minutes=45) <= now)
            waiting = int(((df["airport_outcome"] == "") & ~todo).sum())
            if not todo.any():
                return {"filled": 0, "waiting": waiting}
            # IEM wants UTC dates; Manila is UTC+8, so widen by a day on both sides.
            first = (step[todo].min() - pd.Timedelta(days=1)).date()
            last = (step[todo].max() + pd.Timedelta(days=1)).date()
            raw = fetch_year(station, first, last)
            if raw.empty:
                return {"error": f"the airport archive returned no reports for {station} {first} to {last}"}
            t = pd.to_datetime(raw["valid"], utc=True).dt.tz_convert(TZ).dt.tz_localize(None)
            obs = pd.DataFrame({"time": t, "rain": raw["wxcodes"].map(metar_rain_flag)}).sort_values("time")
            # Several predictions can share a forecast step: label each step once, then map back.
            labels = nearest_obs(pd.DatetimeIndex(sorted(set(step[todo]))), obs, pd.Timedelta(minutes=20)).to_dict()
            df.loc[todo, "airport_outcome"] = ["none" if pd.isna(labels.get(s)) else str(int(labels[s])) for s in step[todo]]
            df.to_csv(LIVE_CSV, index=False)
            return {"filled": int(todo.sum()), "waiting": waiting}
        except Exception as exc:  # network, parsing: report it, do not crash the GUI
            return {"error": str(exc)}

    def _show_outcomes(self, res: dict) -> None:
        self.outcome_busy = False
        self.btn_outcomes.config(state="normal", text="Check outcomes")
        if "error" in res:
            self.rw_label.config(text=f"Outcome check failed: {res['error']}.", foreground=BAD)
            return
        self._refresh_real_world(f"Filled {res['filled']} outcome(s); {res['waiting']} prediction(s) still too recent. ")

    def _refresh_real_world(self, prefix: str = "") -> None:
        """One line: how the saved live predictions and your own reports compare with reality."""
        parts = []
        try:
            df = pd.read_csv(LIVE_CSV, dtype=str, keep_default_na=False) if LIVE_CSV.exists() else None
        except (OSError, ValueError):
            df = None
        if df is not None and "airport_outcome" in df:
            done = df[df["airport_outcome"].isin(["0", "1"])]
            if len(done):
                y = done["airport_outcome"].astype(int).to_numpy()
                p = done["model_probability"].astype(float).to_numpy()
                brier = float(np.mean((p - y) ** 2))
                txt = f"{len(done)} live prediction(s) checked against the airport: model error (Brier) {brier:.3f}"
                om = done[done["openmeteo_probability"] != ""]
                if len(om):
                    yo = om["airport_outcome"].astype(int).to_numpy()
                    txt += f", Open-Meteo's own chance {float(np.mean((om['openmeteo_probability'].astype(float).to_numpy() - yo) ** 2)):.3f}"
                rainy = int(y.sum())
                if rainy:
                    caught = int(((done["rain_mode"] == "1").to_numpy() & (y == 1)).sum())
                    txt += f"; rain caught {caught} of {rainy}"
                parts.append(txt)
            else:
                parts.append("No live prediction has an airport outcome yet (press 'Check outcomes' 45+ minutes after a run)")
        try:
            ob = pd.read_csv(OBSERVATIONS_CSV, dtype=str, keep_default_na=False) if OBSERVATIONS_CSV.exists() else None
        except (OSError, ValueError):
            ob = None
        if ob is not None and len(ob):
            judged = ob[ob["model_agreed"].isin(["0", "1"])]
            parts.append(f"your reports: {len(ob)} ({(judged['observed'] == 'rain').sum()} rain), "
                         f"model agreed with {int(judged['model_agreed'].astype(int).sum())} of {len(judged)}")
        self.rw_label.config(text=prefix + ("; ".join(parts) + "." if parts else "No live predictions saved yet."),
                             foreground=MUTED)

    # ---------------------------------------------------------- heat live
    def _tab_heat_live(self, nb: ttk.Notebook) -> None:
        tab = ttk.Frame(nb, padding=14)
        nb.add(tab, text="Live prediction")
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(6, weight=1)
        ttk.Label(tab, style="Muted.TLabel", wraplength=1100, justify="left", text=(
            "Downloads the current Open-Meteo hourly forecast for the campus point, builds the same features the heat model "
            "was trained on (as HeatModel.php does in the app), and predicts the heat index 1, 2 and 3 hours after the "
            "current hour. Needs internet.")).grid(row=0, column=0, sticky="w")
        act = ttk.Frame(tab)
        act.grid(row=1, column=0, sticky="ew", pady=10)
        act.columnconfigure(1, weight=1)
        self.hl_btn = ttk.Button(act, text="Run a live prediction now", style="Accent.TButton", command=self.heat_live_predict)
        self.hl_btn.grid(row=0, column=0, sticky="nw")
        Tooltip(self.hl_btn, TIPS["go_heat_live"])
        self.hl_status = ttk.Label(act, text="Press the button to score the current Open-Meteo forecast with the trained heat model.",
                                   style="Muted.TLabel", wraplength=900, justify="left")
        self.hl_status.grid(row=0, column=1, sticky="w", padx=14)
        cards = ttk.Frame(tab)
        cards.grid(row=2, column=0, sticky="ew", pady=(0, 8))
        self.hl_cards: list[StatCard] = []
        for i, hours in enumerate((1, 2, 3)):
            cards.columnconfigure(i, weight=1, uniform="hl")
            c = StatCard(cards, f"Heat index in {hours} hour{'s' if hours > 1 else ''}", TIPS["hl_card"])
            c.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
            self.hl_cards.append(c)
        ttk.Label(tab, text="Live predictions made in this session", style="H2.TLabel").grid(row=3, column=0, sticky="w", pady=(4, 4))
        self.hl_log = make_tree(tab, [("Time", 150, "w"), ("+1 h", 150, "e"), ("+2 h", 150, "e"), ("+3 h", 150, "e"),
                                      ("Heat mode", 100, "center"),
                                      ("Open-Meteo's own (+1/+2/+3 h)", 210, "e"), ("Open-Meteo updated", 150, "center")],
                                height=4,
                                heading_tips={"Time": "When the prediction was made (Manila time).",
                                              "+1 h": "The trained model's heat index 1 hour after the current hour.",
                                              "+2 h": "The trained model's heat index 2 hours after the current hour.",
                                              "+3 h": "The trained model's heat index 3 hours after the current hour.",
                                              "Heat mode": f"ON when the heat index is above {HEAT_MODE_C:g} °C now or in "
                                                           "the next hour (the same rule as the app). While it is on, "
                                                           "the app closes exposed outdoor paths to routing, as it does "
                                                           "when it is raining.",
                                              "Open-Meteo's own (+1/+2/+3 h)": "Heat index from Open-Meteo's forecast temperature "
                                                                              "and humidity at the same hours, for comparison.",
                                              "Open-Meteo updated": TIPS["om_updated"]})
        self.hl_log.container.grid(row=4, column=0, sticky="ew")  # type: ignore[attr-defined]
        ttk.Label(tab, text="What the model saw (current hour)", style="H2.TLabel").grid(row=5, column=0, sticky="w", pady=(12, 4))
        self.hl_feat = make_tree(tab, [("Feature", 220, "w"), ("Value", 100, "e"), ("Pushes +1 h (°C)", 130, "e"),
                                       ("Pushes +2 h (°C)", 130, "e"), ("Pushes +3 h (°C)", 130, "e")], height=8,
                                 heading_tips={"Feature": "A weather signal the heat model looks at.",
                                               "Value": "Its value in the current hour of the live forecast."})
        self.hl_feat.container.grid(row=6, column=0, sticky="nsew")  # type: ignore[attr-defined]

    def heat_live_predict(self) -> None:
        if self.heat_live_busy:
            return
        if not self.heat_model:
            self.hl_status.config(text="Train the heat model first (Heat model section, step 2).", foreground=BAD)
            return
        self.heat_live_busy = True
        self.hl_btn.config(state="disabled", text="Fetching live forecast ...")
        self.hl_status.config(text="Contacting Open-Meteo for the current forecast ...", foreground=MUTED)
        model = self.heat_model
        threading.Thread(target=lambda: self.q.put(("heat_live", {**self._heat_live_worker(model), "run": fetch_forecast_run()})),
                         daemon=True).start()

    @staticmethod
    def _heat_live_worker(model: dict) -> dict:
        """Mirror of HeatModel::forecast(): features for the current hour, one ridge score per horizon."""
        try:
            params = {"latitude": LAT, "longitude": LON, "hourly": ",".join(HEAT_VARS),
                      "past_hours": 4, "forecast_hours": 5, "timezone": "Asia/Manila"}
            r = requests.get(OPEN_METEO_LIVE, params=params, timeout=30)
            r.raise_for_status()
            h = pd.DataFrame(r.json()["hourly"])
            h["time"] = pd.to_datetime(h["time"])
            h = h.drop_duplicates("time").set_index("time").sort_index().asfreq("1h")
            feats = build_heat_features(h)
            base = pd.Timestamp(datetime.now(MANILA).replace(tzinfo=None, minute=0, second=0, microsecond=0))
            if base not in feats.index:
                return {"error": f"The forecast has no row for the current hour ({dt12(base)})"}
            if model.get("airport_inputs"):
                # Like HeatModel::forecast(): the airport's latest heat index, or the model without it.
                try:
                    mr = requests.get(AVIATION_WEATHER_METAR, timeout=20, params={"ids": "RPMZ", "format": "json", "hours": 3})
                    mr.raise_for_status()
                    reps = [x for x in mr.json() if isinstance(x, dict) and "obsTime" in x and "rawOb" in x]
                except Exception:
                    reps = []
                reports = pd.DataFrame({"time": [datetime.fromtimestamp(int(x["obsTime"]), MANILA).replace(tzinfo=None, second=0)
                                                 for x in reps], "hi": [airport_heat_index(x["rawOb"]) for x in reps]},
                                       columns=["time", "hi"]).dropna().sort_values("time")
                reports["time"] = reports["time"].astype("datetime64[ns]")
                feats = add_airport_features(feats, reports)
                if pd.isna(feats.loc[base].get("obs_heat_index")) and model.get("fallback"):
                    model = {**model, **model["fallback"]}
            row = feats.loc[base, model["features"]]
            missing = [k for k, v in row.items() if pd.isna(v)]
            if missing:
                return {"error": f"The forecast did not provide: {', '.join(missing)}"}
            fc_hi = heat_index_series(h["temperature_2m"], h["relative_humidity_2m"])
            pushes: dict[str, list[float]] = {name: [] for name in model["features"]}
            preds = []
            for hours in model["horizons"]:
                p = model["per_horizon"][str(hours)]
                value = float(p["intercept"])
                for i, name in enumerate(model["features"]):
                    c = p["coef"][i] * (float(row[name]) - p["mean"][i]) / (p["scale"][i] or 1.0)
                    pushes[name].append(c)
                    value += c
                at = base + pd.Timedelta(hours=hours)
                fc = fc_hi.get(at)
                preds.append({"hours": hours, "at": at, "value": value,
                              "forecast": None if fc is None or pd.isna(fc) else float(fc)})
            now_hi = fc_hi.get(base)
            return {"base": base, "preds": preds, "rows": [(n, float(row[n]), pushes[n]) for n in model["features"]],
                    "now": None if now_hi is None or pd.isna(now_hi) else float(now_hi)}
        except Exception as exc:  # network, parsing, anything: show it, do not crash the GUI
            return {"error": str(exc)}

    def _show_heat_live(self, res: dict) -> None:
        self.heat_live_busy = False
        self.hl_btn.config(state="normal", text="Run a live prediction now")
        if "error" in res:
            self.hl_status.config(text=f"Failed: {res['error']}. Check your internet connection and try again.", foreground=BAD)
            for c in self.hl_cards:
                c.set("-", "last attempt failed")
            return
        ran, run, preds = datetime.now(MANILA), res.get("run"), res["preds"]
        colors = {"none": GOOD, "caution": AMBER, "extreme_caution": AMBER, "danger": BAD, "extreme_danger": BAD}
        worst = "none"
        for card, pr in zip(self.hl_cards, preds):
            value = round(pr["value"], 1)  # the app rounds before choosing the category
            cat = category(value)
            worst = max(worst, cat, key=CATEGORY_KEYS.index)
            fc = "-" if pr["forecast"] is None else f"{pr['forecast']:.1f} °C"
            card.set(f"{value:.1f} °C", f"{HEAT_LABELS[cat]} at {t12(pr['at'])}. Open-Meteo's own: {fc}", colors[cat])
        summary = ", ".join(f"{round(pr['value'], 1):.1f} °C at {t12(pr['at'])}" for pr in preds)
        plus1 = next((round(pr["value"], 1) for pr in preds if pr["hours"] == 1), None)
        heat_on = heat_mode_on(res.get("now"), plus1)
        mode_txt = (f"The app's heat mode would be ON: outdoor paths closed (above {HEAT_MODE_C:g} °C now or in the next hour)."
                    if heat_on else f"The app's heat mode would be OFF (not above {HEAT_MODE_C:g} °C now or in the next hour).")
        self.hl_status.config(
            text=(f"Done at {t12(ran, True)} (Manila time): the heat model predicts {summary} at the campus point. "
                  f"Highest category: {HEAT_LABELS[worst]}. {mode_txt}\n{forecast_run_text(run)}"),
            foreground=BAD if heat_on else colors[worst])
        own = " / ".join("-" if pr["forecast"] is None else f"{pr['forecast']:.1f}" for pr in preds)
        self.hl_log.insert("", 0, values=(dt12(ran, True),
                                          *(f"{round(pr['value'], 1):.1f} °C {HEAT_LABELS[category(round(pr['value'], 1))]}"
                                            for pr in preds),
                                          "ON" if heat_on else "OFF",
                                          own, forecast_run_short(run)))
        updated = "-" if not run or "error" in run else f"{run['published']:%Y-%m-%d %H:%M}"
        append_csv_row(REPORTS / "heat_live_predictions.csv",
                       ["run_time_manila", "base_hour"] + [f"model_hi_{p['hours']}h" for p in preds]
                       + [f"openmeteo_hi_{p['hours']}h" for p in preds] + ["openmeteo_updated_manila", "heat_mode"],
                       [f"{ran:%Y-%m-%d %H:%M:%S}", f"{res['base']:%Y-%m-%d %H:%M}"]
                       + [f"{p['value']:.2f}" for p in preds]
                       + ["" if p["forecast"] is None else f"{p['forecast']:.2f}" for p in preds]
                       + ["" if updated == "-" else updated, "on" if heat_on else "off"])
        rows = sorted(res["rows"], key=lambda r: abs(r[2][0]), reverse=True)
        fill_tree(self.hl_feat, [(HEAT_FEATURE_LABELS.get(n, n), f"{v:.3f}", *(f"{c:+.2f}" for c in cs)) for n, v, cs in rows])

    # ------------------------------------------------- simple / detailed
    def _split(self, tab: ttk.Frame) -> tuple[ttk.Frame, ttk.Frame]:
        simple, detail = ttk.Frame(tab), ttk.Frame(tab)
        self._view_frames.append((simple, detail))
        return simple, detail

    def _apply_view(self) -> None:
        simple = self.v_view.get() == "simple"
        for s, d in self._view_frames:
            (d if simple else s).pack_forget()
            (s if simple else d).pack(fill="both", expand=True)

    def _tab_tip(self, event) -> str | None:
        nb = event.widget
        try:
            idx = nb.index(f"@{event.x},{event.y}")
        except (tk.TclError, AttributeError):
            return None
        return TAB_TIPS.get(nb.tab(idx, "text"))

    # ---------------------------------------------------------- scorecard
    def _tab_scorecard(self) -> None:
        outer = ttk.Frame(self.tabs, padding=(14, 14, 0, 0))
        self.tabs.add(outer, text="Scorecard")
        # Scrollable: the cards, checklist, live buttons and session table are taller than a small window.
        sf = ScrollFrame(outer)
        sf.pack(fill="both", expand=True)
        tab = sf.inner
        tab.columnconfigure(0, weight=1)
        spec = [[("Trained on", "c_train"), ("Tested on unseen data", "c_test"),
                 ("Ranking quality", "c_auc"), ("Reliability", "c_rel")],
                [("Error vs Open-Meteo", "c_raw"), ("Rain caught", "c_recall"),
                 ("Warnings that were right", "c_prec"), ("Latest live prediction", "c_live")]]
        self.sc_cards: list[StatCard] = []
        for r, row_spec in enumerate(spec, start=1):
            row = ttk.Frame(tab)
            row.grid(row=r, column=0, sticky="ew", pady=(0, 8))
            for i, (title, tip) in enumerate(row_spec):
                row.columnconfigure(i, weight=1, uniform=f"sc{r}")
                c = StatCard(row, title, TIPS[tip])
                c.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
                self.sc_cards.append(c)
        self.sc_live = self.sc_cards[7]
        ttk.Label(tab, text="Is it working as intended?", style="H2.TLabel").grid(row=3, column=0, sticky="w", pady=(8, 4))
        self.sc_checks = ttk.Frame(tab)
        self.sc_checks.grid(row=4, column=0, sticky="w")
        act = ttk.Frame(tab)
        act.grid(row=5, column=0, sticky="ew", pady=(12, 0))
        act.columnconfigure(1, weight=1)
        guide = ttk.LabelFrame(act, text="How to check the model in real life", padding=(10, 6))
        guide.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 10))
        for i, line in enumerate((
            "1.  When you can see the weather on campus, click It's raining or It's dry. You do not need to click "
            "'Run a live prediction now' first: the button runs a fresh prediction itself and saves your answer with it.",
            "2.  Report dry moments too, not only when the model gets it wrong, or the record will make the model look worse "
            "than it is. One report every 20 minutes or more is plenty.",
            "3.  45 minutes or more after a prediction, click Check outcomes to fill in what the airport reported.",
            "'Run a live prediction now' only shows the model's current answer; it does not save a report. Your reports are "
            "kept in ml/reports and are not used for training yet.",
        )):
            ttk.Label(guide, text=line, style="Muted.TLabel" if i == 3 else "TLabel", wraplength=1050,
                      justify="left").pack(anchor="w", pady=(4 if i == 3 else 0, 0))
        self.sc_btn = ttk.Button(act, text="Run a live prediction now", style="Accent.TButton", command=self.live_predict)
        self.sc_btn.grid(row=1, column=0, sticky="nw")
        Tooltip(self.sc_btn, TIPS["go_live"])
        self.sc_status = ttk.Label(act, text="Press the button to score the current Open-Meteo forecast with the trained model.",
                                   style="Muted.TLabel", wraplength=900, justify="left")
        self.sc_status.grid(row=1, column=1, rowspan=2, sticky="nw", padx=14)
        obs_row = ttk.Frame(act)
        obs_row.grid(row=2, column=0, sticky="nw", pady=(8, 0))
        self.obs_btns = [ttk.Button(obs_row, text="It's raining", command=lambda: self.observe("rain")),
                         ttk.Button(obs_row, text="It's dry", command=lambda: self.observe("dry"))]
        for i, b in enumerate(self.obs_btns):
            b.pack(side="left", padx=(0 if i == 0 else 6, 0))
            Tooltip(b, TIPS["obs_buttons"])
        rw = ttk.Frame(act)
        rw.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(8, 0))
        rw.columnconfigure(1, weight=1)
        self.btn_outcomes = ttk.Button(rw, text="Check outcomes", command=self.check_outcomes)
        self.btn_outcomes.grid(row=0, column=0, sticky="w")
        Tooltip(self.btn_outcomes, TIPS["check_outcomes"])
        self.rw_label = ttk.Label(rw, text="", style="Muted.TLabel", wraplength=900, justify="left")
        self.rw_label.grid(row=0, column=1, sticky="w", padx=14)
        ttk.Label(tab, text="Live predictions made in this session", style="H2.TLabel").grid(row=6, column=0, sticky="w", pady=(12, 4))
        self.sc_log = make_tree(tab, [("Time", 150, "w"), ("Model's chance", 120, "e"), ("Open-Meteo's own chance", 170, "e"),
                                      ("Rain mode", 100, "center"), ("Open-Meteo updated", 150, "center")], height=4,
                                heading_tips={"Time": "When the prediction was made (Manila time).",
                                              "Model's chance": "The trained model's probability of rain in the next 20 minutes.",
                                              "Open-Meteo's own chance": "Open-Meteo's own rain probability for the next hour, for comparison.",
                                              "Rain mode": "ON when the model's chance reaches the alert threshold, or (as in the app) when Open-Meteo's current reading already shows rain.",
                                              "Open-Meteo updated": TIPS["om_updated"]})
        self.sc_log.container.grid(row=7, column=0, sticky="ew")  # type: ignore[attr-defined]
        ttk.Label(tab, text=TIPS["how_judged"], style="Muted.TLabel", wraplength=1150,
                  justify="left").grid(row=8, column=0, sticky="w", pady=(10, 0))

    def _build_dataset_simple(self, simple: ttk.Frame) -> None:
        simple.columnconfigure(0, weight=1)
        simple.rowconfigure(2, weight=1)
        ttk.Label(simple, wraplength=1150, justify="left", text=(
            "The AI learned from real weather history for Zamboanga City. Open-Meteo supplies the weather conditions, "
            "and real airport reports (METAR) tell it when it actually rained.")).grid(row=0, column=0, sticky="w", pady=(0, 10))
        row = ttk.Frame(simple)
        row.grid(row=1, column=0, sticky="ew", pady=(0, 8))
        self.ds_s_cards = []
        for i, (t, tip) in enumerate((
                ("Weather records", "Rows of weather conditions (rain, temperature, humidity, wind, pressure) at 15-minute steps from Open-Meteo, for the grid cell nearest the campus."),
                ("Real rain reports", "Observations from the airport weather station. They say whether it was really raining at the time, unlike model data."),
                ("Training / test rows", "Labeled moments used for learning (first number) and for the final unseen test (second number)."))):
            row.columnconfigure(i, weight=1, uniform="dss")
            c = StatCard(row, t, tip)
            c.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
            self.ds_s_cards.append(c)
        self.ds_s_chart = ChartPanel(simple, height=340)
        self.ds_s_chart.grid(row=2, column=0, sticky="new")

    def _build_preview_simple(self, simple: ttk.Frame) -> None:
        simple.columnconfigure(0, weight=1)
        ttk.Label(simple, text="Latest 12 weather records downloaded (15-minute steps)", style="H2.TLabel").grid(row=0, column=0, sticky="w", pady=(0, 4))
        self.pv_s1 = make_tree(simple, [("Time", 150, "w"), ("Rain (mm)", 90, "e"), ("Temperature (\u00b0C)", 120, "e"),
                                        ("Humidity (%)", 100, "e"), ("Wind (km/h)", 100, "e")], height=12)
        self.pv_s1.container.grid(row=1, column=0, sticky="ew")  # type: ignore[attr-defined]
        ttk.Label(simple, text="Latest real airport observations (was it raining?)", style="H2.TLabel").grid(row=2, column=0, sticky="w", pady=(12, 4))
        self.pv_s2 = make_tree(simple, [("Time (Manila)", 170, "w"), ("Rain reported", 120, "center")], height=8)
        self.pv_s2.container.grid(row=3, column=0, sticky="ew")  # type: ignore[attr-defined]

    def _build_model_simple(self, simple: ttk.Frame) -> None:
        simple.columnconfigure(0, weight=1)
        simple.rowconfigure(3, weight=1)
        self.md_s_badge = ttk.Label(simple, text="", style="Verdict.TLabel")
        self.md_s_badge.grid(row=0, column=0, sticky="w", pady=(0, 8))
        row = ttk.Frame(simple)
        row.grid(row=1, column=0, sticky="ew", pady=(0, 8))
        self.md_s_cards = []
        for i, (t, tip) in enumerate((
                ("Status", "Whether a trained model file (model.json) exists."),
                ("Predicts", "The question the model answers every time it is used."),
                ("Learned from", "Number of 15-minute moments used for learning."),
                ("Weather signals used", "How many different measurements the model looks at, such as recent rain, humidity, pressure and time of day."))):
            row.columnconfigure(i, weight=1, uniform="mds")
            c = StatCard(row, t, tip)
            c.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
            self.md_s_cards.append(c)
        self.md_s_text = ttk.Label(simple, wraplength=1150, justify="left")
        self.md_s_text.grid(row=2, column=0, sticky="w", pady=(0, 6))
        self.md_s_chart = ChartPanel(simple, height=340)
        self.md_s_chart.grid(row=3, column=0, sticky="new")

    def _build_eval_simple(self, simple: ttk.Frame) -> None:
        simple.columnconfigure(0, weight=1)
        simple.rowconfigure(1, weight=1)
        self.ev_s_text = ttk.Label(simple, wraplength=1150, justify="left")
        self.ev_s_text.grid(row=0, column=0, sticky="w", pady=(0, 8))
        self.ev_s_chart = ChartPanel(simple, height=380)
        self.ev_s_chart.grid(row=1, column=0, sticky="new")

    # ------------------------------------------------- simple-view contents
    def _update_simple(self) -> None:
        d, m, mt = self.data, self.model, self.metrics
        splits = {s["split"]: s for s in read_split_log()}
        yrs = (f"{(d.m15.index.max() - d.m15.index.min()).days / 365.25:.1f} years"
               if d.m15 is not None and len(d.m15) else "-")
        lr = raw = None
        imp_raw = imp_const = gap = None
        thr = None
        if mt and m:
            res = mt["results"]
            lr = exported_result(res)
            raw = res.get("raw Open-Meteo probability")
            rr = lr["rain_rate"]
            const = rr * (1 - rr)
            imp_raw = (raw["brier"] - lr["brier"]) / raw["brier"] * 100 if raw else None
            imp_const = (const - lr["brier"]) / const * 100 if const else None
            gap = calibration_gap(mt.get("calibration", []))
            thr = mt["alert_threshold"]
            auc_word, auc_col = rate(lr["roc_auc"], 0.80, 0.70)
            gap_word, gap_col = rate(gap, 0.03, 0.06, higher_better=False)

        # ---- scorecard verdict
        if not (m and mt):
            self.sc_verdict.config(text="Not ready: the model has not been trained yet (see the Rain model section).", foreground=BAD)
        elif m.get("recommended") and (lr["roc_auc"] or 0) >= 0.7:
            self.sc_verdict.config(text="Trained and predicting: on data it never saw, it beats the simpler methods and "
                                        "Open-Meteo's own rain chance.", foreground=GOOD)
        else:
            self.sc_verdict.config(text="Trained, but it did not clearly beat the simpler methods. Keep using "
                                        "Open-Meteo's own rain chance until it does.", foreground=AMBER)

        # ---- scorecard cards
        c = self.sc_cards
        tr, te = splits.get("train"), splits.get("test")
        if tr:
            c[0].set(f"{tr['rows']:,}", f"15-minute moments, {tr['start']} to {tr['end']}")
        else:
            c[0].set("-", "run training once from the Rain model section to record this")
        if lr:
            period = m["periods"]["test"]
            c[1].set(f"{lr['n']:,}", f"{period[0]} to {period[1]}; never used for learning")
            c[2].set(fmt(lr["roc_auc"], 2), f"{auc_word}. 0.50 is a coin flip, 1.00 is perfect", auc_col)
            if gap is not None:
                c[3].set(f"\u00b1{gap * 100:.1f} pts", f"{gap_word}. average gap between predicted and real rain rate", gap_col)
            else:
                c[3].set("-", "")
            if imp_raw is not None:
                c[4].set(f"{imp_raw:.0f}% lower", "probability error than Open-Meteo's own rain chance",
                         GOOD if imp_raw > 0 else BAD)
            else:
                c[4].set("-", "Open-Meteo probability not available")
            c[5].set(f"{(lr['recall'] or 0) * 100:.0f}%", f"of rainy moments warned (alert threshold {thr})")
            fpr = lr["false_positive_rate"]
            c[6].set("-" if lr["precision"] is None else f"{lr['precision'] * 100:.0f}%",
                     f"false alarms on {0 if fpr is None else fpr * 100:.1f}% of dry moments")
        else:
            for card in c[1:7]:
                card.set("-", "train the model first")
        if self.sc_live.value.cget("text") == "-":
            self.sc_live.set("-", "press the button below" if m else "train the model first")

        # ---- checklist
        for w in self.sc_checks.winfo_children():
            w.destroy()
        items: list[tuple[str, str]] = []
        have = d.m15 is not None and d.metar is not None
        items.append(("ok" if have else "no",
                      f"Dataset downloaded: {len(d.m15):,} weather records over {yrs}, {len(d.metar):,} real airport rain reports"
                      if have else "Dataset not downloaded yet"))
        items.append(("ok" if m else "no", f"Model trained ({m['created'][:10]})" if m else "Model not trained yet"))
        if lr:
            per = m["periods"]["test"]
            items.append(("ok", f"Tested on {lr['n']:,} unseen moments ({per[0]} to {per[1]}) that were never used for learning"))
            items.append(("ok" if m.get("recommended") else "warn",
                          "Beats the simpler ways of guessing that the app could use" if m.get("recommended")
                          else "Does not beat every simpler way of guessing"))
            if imp_const is not None:
                modest = " (a modest gain)" if 0 < imp_const < 20 else ""
                items.append(("ok" if imp_const > 0 else "warn",
                              f"{abs(imp_const):.0f}% {'lower' if imp_const > 0 else 'higher'} error than always guessing the average rain rate{modest}"))
            if gap is not None:
                items.append(("ok" if gap_word == "Good" else "warn",
                              f"Predicted probabilities match real rain frequency (average gap {gap * 100:.1f} points)"))
            note = over_warn_note(mt.get("calibration", []))
            if note:
                items.append(("warn", note))
        items.append(("ok" if m else "no", "Live prediction available (current Open-Meteo forecast scored by the trained model)"))
        sym = {"ok": ("\u2714", GOOD), "warn": ("\u26a0", AMBER), "no": ("\u2716", BAD)}
        for status, text in items:
            row = ttk.Frame(self.sc_checks)
            row.pack(anchor="w", pady=1)
            ttk.Label(row, text=sym[status][0], foreground=sym[status][1], width=2).pack(side="left")
            ttk.Label(row, text=text).pack(side="left")

        # ---- dataset (simple)
        s0, s1, s2 = self.ds_s_cards
        s0.set(fmt(len(d.m15)) if d.m15 is not None else "-",
               f"Open-Meteo, {yrs}" if d.m15 is not None else "not downloaded yet")
        if d.metar is not None and len(d.metar):
            s1.set(fmt(len(d.metar)), f"{d.metar['rain'].mean() * 100:.1f}% reported rain; airport station RPMZ")
        else:
            s1.set("-", "not downloaded yet")
        if tr and te:
            s2.set(f"{tr['rows']:,} / {te['rows']:,}", "used for learning / kept hidden for testing")
        else:
            s2.set("-", "run training once from the Rain model section")
        self.ds_s_chart.show(fig_openmeteo_monthly(d.m15))

        # ---- data preview (simple)
        if d.m15 is not None:
            fill_tree(self.pv_s1, [(dt12(i), f"{r.precipitation:.2f}", f"{r.temperature_2m:.1f}",
                                    f"{r.relative_humidity_2m:.0f}", f"{r.wind_speed_10m:.1f}")
                                   for i, r in d.m15.tail(12).iterrows()])
        else:
            fill_tree(self.pv_s1, [("not downloaded yet", "", "", "", "")])
        if d.metar is not None:
            fill_tree(self.pv_s2, [(dt12(r.time), "Yes" if r.rain else "No") for r in d.metar.tail(8).itertuples()])
        else:
            fill_tree(self.pv_s2, [("not downloaded yet", "")])

        # ---- model (simple)
        m0, m1, m2, m3 = self.md_s_cards
        if m:
            self.md_s_badge.config(text="Trained and recommended for use" if m.get("recommended")
                                   else "Trained, but not recommended over Open-Meteo's own rain chance",
                                   foreground=GOOD if m.get("recommended") else AMBER)
            m0.set("Trained", f"created {m['created'][:10]}", GOOD)
            m1.set(f"Rain in {m['horizon_minutes']} min", "at the Zamboanga City campus point")
            m2.set(f"{tr['rows']:,}" if tr else "-", "moments of real weather history" if tr else "run training once from the Rain model section")
            m3.set(str(len(m["features"])), "weather measurements")
            order = np.argsort(np.abs(signal_weights(m)[0]))[::-1][:3]
            self.md_s_text.config(text="The model combines these measurements into one rain probability. Most influential: " +
                                       ", ".join(FEATURE_LABELS.get(m["features"][i], m["features"][i]) for i in order) + ".")
        else:
            self.md_s_badge.config(text="No model trained yet", foreground=MUTED)
            for card in (m0, m1, m2, m3):
                card.set("-", "")
            self.md_s_text.config(text="")
        self.md_s_chart.show(fig_top_signals(m))

        # ---- evaluation (simple)
        if lr:
            rr = lr["rain_rate"]
            parts = [f"On {lr['n']:,} test moments the model never saw, its probability error is {lr['brier']:.3f}"]
            if raw:
                parts.append(f", compared with {raw['brier']:.3f} for Open-Meteo's own rain chance")
            parts.append(f" and {rr * (1 - rr):.3f} for always guessing the average rain rate. Lower is better. "
                         f"It also ranks rainy moments above dry ones with a score of {lr['roc_auc']:.2f} (1.00 is perfect).")
            self.ev_s_text.config(text="".join(parts))
        else:
            self.ev_s_text.config(text="No evaluation yet. Train the model in the Rain model section.")
        self.ev_s_chart.show(fig_compare(mt))

    # ------------------------------------------------------------ refresh
    def refresh(self) -> None:
        self.data.load()
        self.model = read_json(MODEL_JSON)
        self.metrics = read_json(METRICS_JSON)
        self.heat_model = read_json(HEAT_MODEL_JSON)
        self.heat_metrics = read_json(HEAT_METRICS_JSON)
        splits = read_split_log()
        d = self.data

        # pipeline step status
        def line(name: str, path: Path, df: pd.DataFrame | None, n: int | None = None) -> str:
            if not path.exists():
                return f"[ ]  {name}: not downloaded yet"
            return f"[x]  {name}: {path.name}"

        trained = f"model.json created {self.model['created']}" if self.model else "not trained yet"
        self.step_status.config(text="\n".join([
            line("1 Open-Meteo", M15_CSV, d.m15), line("1 Several models", MULTIMODEL_CSV, None),
            line("2 METAR", METAR_CSV, None), line("2b Satellite (optional)", SAT_CSV, None),
            f"[{'x' if self.model else ' '}]  3 Model: {trained}"]))

        # dataset tab
        n15, nh = (len(d.m15) if d.m15 is not None else None), (len(d.hourly) if d.hourly is not None else None)
        self.cards[0].set(fmt(n15), Dataset.span(d.m15))
        self.cards[1].set(fmt(nh), Dataset.span(d.hourly))
        if d.metar is not None and len(d.metar):
            self.cards[2].set(fmt(len(d.metar)), f"{d.metar['rain'].mean() * 100:.1f}% reports with rain; "
                                                 f"{d.metar['time'].min():%Y-%m-%d} to {d.metar['time'].max():%Y-%m-%d}")
        else:
            self.cards[2].set("-", "not downloaded yet")
        if splits:
            self.cards[3].set(fmt(sum(s["rows"] for s in splits)), "train / validation / test: " +
                              " / ".join(f"{s['rows']:,}" for s in splits))
        else:
            self.cards[3].set("-", "run training from the Rain model section to record split sizes")

        files = []
        for label, path, df in (("openmeteo_minutely15.csv", M15_CSV, d.m15), ("openmeteo_hourly.csv", HOURLY_CSV, d.hourly)):
            if df is not None:
                files.append((label, f"{len(df):,}", Dataset.span(df), human_size(path.stat().st_size)))
        if d.metar is not None:
            files.append(("metar.csv", f"{len(d.metar):,}",
                          f"{d.metar['time'].min():%Y-%m-%d} to {d.metar['time'].max():%Y-%m-%d}",
                          human_size(METAR_CSV.stat().st_size)))
        if MULTIMODEL_CSV.exists():
            files.append((MULTIMODEL_CSV.name, "-", f"{len(MM_MODELS)} models, hourly", human_size(MULTIMODEL_CSV.stat().st_size)))
        for sat_csv in (SAT_CSV, SAT_B10_CSV):
            if not sat_csv.exists():
                continue
            try:
                sat = pd.read_csv(sat_csv, usecols=["stamp", "satellite"], dtype=str)
                have = sat[sat["satellite"].notna()]["stamp"]
                span = f"{have.min()[:8]} to {have.max()[:8]} (UTC)" if len(have) else "-"
                files.append((sat_csv.name, f"{len(have):,} scans", span, human_size(sat_csv.stat().st_size)))
            except (ValueError, KeyError, OSError):
                files.append((sat_csv.name, "unreadable", "-", human_size(sat_csv.stat().st_size)))
        if MODEL_JSON.exists():
            files.append(("model.json", f"{len(self.model['features'])} features" if self.model else "-", "-",
                          human_size(MODEL_JSON.stat().st_size)))
        fill_tree(self.files_tree, files or [("no files yet", "", "", "")])

        cols = []
        for label, df in (("15-minute", d.m15), ("hourly", d.hourly)):
            if df is not None:
                cols += [(label, c, f"{df[c].isna().mean() * 100:.1f}%") for c in df.columns]
        fill_tree(self.cols_tree, cols)
        self.chart_om.show(fig_openmeteo_monthly(d.m15))
        self.chart_mt.show(fig_metar_monthly(d.metar))
        self._fill_preview()

        # model tab
        m = self.model
        if m:
            self.model_badge.config(text="Recommended: beats every deployable baseline" if m.get("recommended")
                                    else "Not recommended: keep the raw Open-Meteo probability",
                                    foreground=GOOD if m.get("recommended") else BAD)
            fill_tree(self.info_tree, [
                ("Model type", ("Gradient-boosted trees" if m.get("kind") == "trees" else "Logistic regression")
                 + (", calibrated" if m.get("calibration") else "") + " (scored in plain PHP by RainModel.php)"),
                ("Question answered", f"Rain within {m['horizon_minutes']} minutes at the campus point"),
                ("Label source", m["label_source"]),
                ("Alert threshold (rain mode)", fmt(m["alert_threshold"], 2)),
                ("Regularisation C" if "C" in m else "Trees",
                 fmt(m["C"], 2) if "C" in m else f"{len(m.get('trees', []))} (depth {m.get('tree_params', {}).get('max_depth', '-')})"),
                ("Features", str(len(m["features"]))),
                ("Created (UTC)", m["created"]),
                ("Attribution", m.get("attribution", "")),
                ("model.json SHA-256", sha256_of(MODEL_JSON)[:32] + "..."),
            ])
            if splits:
                fill_tree(self.split_tree, [(s["split"], s["start"], s["end"], f"{s['rows']:,}", f"{s['rain']:.3f}", s["months"]) for s in splits])
            else:
                p = m.get("periods", {})
                fill_tree(self.split_tree, [(k, v[0], v[1], "-", "-", "-") for k, v in p.items()])
            if "coef" in m:
                fill_tree(self.feat_tree, [(n, f"{w:+.3f}", f"{mu:.3f}", f"{sc:.3f}")
                                           for n, w, mu, sc in zip(m["features"], m["coef"], m["mean"], m["scale"])])
            else:  # trees: importance instead of a weight; trees need no mean/scale
                fill_tree(self.feat_tree, [(n, f"{w:.4f}", "-", "-") for n, w in zip(m["features"], signal_weights(m)[0])])
        else:
            self.model_badge.config(text="No model trained yet", foreground=MUTED)
            for t in (self.info_tree, self.split_tree, self.feat_tree):
                fill_tree(t, [])
        self.chart_coef.show(fig_coefficients(m))

        # evaluation tab
        mt = self.metrics
        if mt:
            self.eval_head.config(text=f"Label: {mt['label']}    Alert threshold: {mt['alert_threshold']}")
            fill_tree(self.eval_tree, [(k, fmt(v["n"]), fmt(v["rain_rate"]), fmt(v["brier"], 5), fmt(v["roc_auc"]),
                                        fmt(v["precision"]), fmt(v["recall"]), fmt(v.get("start_recall")),
                                        fmt(v["false_alarm_ratio"]), fmt(v["false_positive_rate"])) for k, v in mt["results"].items()])
        else:
            self.eval_head.config(text="No evaluation yet. Train the model in the Rain model section.")
            fill_tree(self.eval_tree, [])
        self.chart_brier.show(fig_brier(mt))
        self.chart_cal.show(fig_calibration(mt))
        self._update_simple()
        self._refresh_real_world()
        self._refresh_heat()
        self._refresh_overview()
        self._refresh_results()
        self._refresh_export()

    # ======================================================== layout shell
    def _nav(self) -> None:
        """Left sidebar: one button per section (Ctrl+1 .. Ctrl+8), content on the right."""
        body = ttk.Frame(self)
        body.pack(fill="both", expand=True, padx=(12, 12), pady=(0, 4))
        side = ttk.Frame(body, style="Side.TFrame", padding=(6, 8))
        side.pack(side="left", fill="y")
        ttk.Label(side, text="SECTIONS", style="SideHead.TLabel").pack(anchor="w", padx=8, pady=(0, 6))
        self.content = ttk.Frame(body, padding=(12, 0, 0, 0))
        self.content.pack(side="left", fill="both", expand=True)
        self.sections: dict[str, ttk.Frame] = {}
        self.nav_buttons: dict[str, ttk.Button] = {}
        for i, (key, label) in enumerate(SECTIONS, start=1):
            b = ttk.Button(side, text=label, style="Nav.TButton", command=lambda k=key: self.show_section(k))
            b.pack(fill="x", pady=1)
            Tooltip(b, f"{SECTION_TIPS[key]}\n\nShortcut: Ctrl+{i}")
            self.nav_buttons[key] = b
            self.bind_all(f"<Control-Key-{i}>", lambda _e, k=key: self.show_section(k))
        ttk.Label(side, text="F5  reload files\nCtrl+1-8  sections\nTab  move between controls",
                  style="SideNote.TLabel", justify="left").pack(side="bottom", anchor="w", padx=8, pady=(12, 0))
        self.bind_all("<F5>", lambda _e: self.refresh())
        self.current_section: str | None = None

    def _new_section(self, key: str) -> ttk.Frame:
        frame = ttk.Frame(self.content)
        self.sections[key] = frame
        return frame

    def show_section(self, key: str) -> None:
        if key == self.current_section:
            return
        for k, f in self.sections.items():
            if k != key:
                f.pack_forget()
        self.sections[key].pack(fill="both", expand=True)
        if key == "history" and not self.history_loaded:
            self.load_history()
        for k, b in self.nav_buttons.items():
            b.configure(style="NavActive.TButton" if k == key else "Nav.TButton")
        self.current_section = key

    def _model_strip(self, parent, title: str) -> dict:
        """The same header for both models: title, verdict, data status, settings, train buttons, progress."""
        strip = ttk.Frame(parent)
        strip.pack(fill="x")
        strip.columnconfigure(0, weight=1)
        ttk.Label(strip, text=title, style="H1.TLabel").grid(row=0, column=0, sticky="w")
        verdict = ttk.Label(strip, text="", style="Verdict.TLabel", justify="left")
        verdict.grid(row=1, column=0, sticky="ew", pady=(4, 6))
        status = ttk.Label(strip, text="", style="Muted.TLabel", justify="left")
        status.grid(row=2, column=0, sticky="ew")
        settings = ttk.LabelFrame(strip, text="Training settings", padding=(10, 6))
        settings.grid(row=3, column=0, sticky="ew", pady=(8, 0))
        actions = ttk.Frame(strip)
        actions.grid(row=4, column=0, sticky="ew", pady=(8, 0))
        progress = ttk.Progressbar(actions, mode="indeterminate", length=160)
        run_state = ttk.Label(actions, text="Idle", style="Muted.TLabel")

        def wrap(e) -> None:
            for w in (verdict, status, run_state):
                w.configure(wraplength=max(300, e.width - 20))
        strip.bind("<Configure>", wrap, add="+")
        return {"frame": strip, "verdict": verdict, "status": status, "settings": settings,
                "actions": actions, "progress": progress, "run_state": run_state}

    @staticmethod
    def _setting(parent, col: int, text: str, var: tk.StringVar, tip: str, width: int = 12, values=None) -> None:
        lab = ttk.Label(parent, text=text + "  ⓘ")
        lab.grid(row=0, column=col * 2, sticky="w", padx=(0 if col == 0 else 16, 6))
        if values:
            w = ttk.Combobox(parent, textvariable=var, values=values, width=width, state="readonly")
        else:
            w = ttk.Entry(parent, textvariable=var, width=width)
        w.grid(row=0, column=col * 2 + 1)
        Tooltip(lab, tip)
        Tooltip(w, tip)

    # ============================================================ sections
    def _section_overview(self) -> None:
        sec = self._new_section("overview")
        sf = ScrollFrame(sec)
        sf.pack(fill="both", expand=True)
        inner = sf.inner
        inner.columnconfigure((0, 1), weight=1, uniform="ov")
        ttk.Label(inner, text="AR-Node weather models", style="H1.TLabel").grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(inner, style="Muted.TLabel", wraplength=1000, justify="left", text=(
            "Two small models feed the campus navigation app. The rain model says whether it will rain on campus in "
            "the next 20 minutes, so routes can prefer covered paths. The heat model says what the heat index will be "
            "in 1, 2 and 3 hours. Both are trained here, saved as JSON next to this file, and scored in plain PHP by "
            "the server. Nothing in this window changes the app until a training run writes a new JSON file.")
                  ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(4, 12))
        self.ov_boxes = {}
        for col, (key, title, target) in enumerate((("rain", "Rain model", "rain"), ("heat", "Heat model", "heat"))):
            box = ttk.LabelFrame(inner, text=title, padding=12)
            box.grid(row=2, column=col, sticky="nsew", padx=(0 if col == 0 else 8, 0))
            verdict = ttk.Label(box, text="", style="H2.TLabel", wraplength=480, justify="left")
            verdict.pack(anchor="w")
            checks = ttk.Frame(box)
            checks.pack(anchor="w", fill="x", pady=(8, 8))
            ttk.Button(box, text=f"Open {title.lower()}", command=lambda t=target: self.show_section(t)).pack(anchor="w")
            self.ov_boxes[key] = (verdict, checks)
        ttk.Label(inner, text="What to do next", style="H2.TLabel").grid(row=3, column=0, columnspan=2, sticky="w", pady=(16, 4))
        self.ov_next = ttk.Label(inner, text="", wraplength=1000, justify="left")
        self.ov_next.grid(row=4, column=0, columnspan=2, sticky="w")

    def _section_data(self) -> None:
        sec = self._new_section("data")
        ttk.Label(sec, text="Data", style="H1.TLabel").pack(anchor="w")
        ttk.Label(sec, text="What each model learned from. Downloads run from the Rain model and Heat model sections.",
                  style="Muted.TLabel").pack(anchor="w", pady=(2, 8))
        nb = ttk.Notebook(sec)
        nb.pack(fill="both", expand=True)
        Tooltip(nb, lookup=self._tab_tip)
        self.tabs = nb
        self._tab_dataset()
        self._tab_heat_dataset()
        self._tab_preview()

    def _tab_heat_dataset(self) -> None:
        tab = ttk.Frame(self.tabs, padding=14)
        self.tabs.add(tab, text="Heat dataset")
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(2, weight=1)
        cards = ttk.Frame(tab)
        cards.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        self.hd_cards = [StatCard(cards, t, tip) for t, tip in (
            ("ERA5 hourly rows", TIPS["hd_era5"]), ("Archived forecast rows", TIPS["hd_fc"]),
            ("Heat index (ERA5)", TIPS["hd_hi"]), ("Hours by category (ERA5)", TIPS["hd_cat"]))]
        for i, c in enumerate(self.hd_cards):
            cards.columnconfigure(i, weight=1, uniform="hd")
            c.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
        self.hd_files = make_tree(tab, [("File", 220, "w"), ("Rows", 90, "e"), ("Date range", 200, "w"),
                                        ("Missing", 80, "e"), ("Size", 80, "e")], height=2)
        self.hd_files.container.grid(row=1, column=0, sticky="ew", pady=(0, 8))  # type: ignore[attr-defined]
        self.hd_chart = ChartPanel(tab)
        self.hd_chart.grid(row=2, column=0, sticky="nsew")

    def _section_rain(self) -> None:
        sec = self._new_section("rain")
        s = self._model_strip(sec, "Rain model: rain on campus in the next 20 minutes")
        self.rain_strip = s
        self.sc_verdict = s["verdict"]
        self.step_status = s["status"]
        self.v_start = tk.StringVar(value="2022-01-01")
        self.v_station = tk.StringVar(value="RPMZ")
        self.v_alert = tk.StringVar(value="auto")
        self.v_label = tk.StringVar(value="auto")
        self._setting(s["settings"], 0, "History starts", self.v_start, TIPS["start"])
        self._setting(s["settings"], 1, "METAR station", self.v_station, TIPS["station"], 8)
        self._setting(s["settings"], 2, "Alert threshold", self.v_alert, TIPS["alert"], 6, ["auto", "0.2", "0.3", "0.4", "0.5", "0.6"])
        self._setting(s["settings"], 3, "Label source", self.v_label, TIPS["label"], 10, ["auto", "metar", "openmeteo"])
        self.v_sat_start = tk.StringVar(value="2024-01-01")
        self._setting(s["settings"], 4, "Satellite from", self.v_sat_start, TIPS["sat_start"])
        self.v_kind = tk.StringVar(value="logistic")
        self._setting(s["settings"], 5, "Model type", self.v_kind, TIPS["kind"], 8, ["logistic", "trees", "auto"])
        a = s["actions"]
        self.btn_om = ttk.Button(a, text="1  Download Open-Meteo", command=lambda: self.run(["om", "mm"]))
        self.btn_mt = ttk.Button(a, text="2  Download METAR", command=lambda: self.run(["metar"]))
        self.btn_sat = ttk.Button(a, text="2b  Download satellite", command=lambda: self.run(["sat"]))
        self.btn_tr = ttk.Button(a, text="3  Train and evaluate", command=lambda: self.run(["train"]))
        self.btn_tr60 = ttk.Button(a, text="3b  Train 60-min model", command=lambda: self.run(["train60"]))
        self.btn_all = ttk.Button(a, text="Run all steps", style="Accent.TButton", command=lambda: self.run(["om", "mm", "metar", "train"]))
        self.btn_stop = ttk.Button(a, text="Stop", command=self.stop, state="disabled")
        for b, k in ((self.btn_om, "b_om"), (self.btn_mt, "b_mt"), (self.btn_sat, "b_sat"), (self.btn_tr, "b_tr"), (self.btn_tr60, "b_tr60"),
                     (self.btn_all, "b_all"), (self.btn_stop, "b_stop")):
            b.pack(side="left", padx=(0, 8))
            Tooltip(b, TIPS[k])
        s["progress"].pack(side="left", padx=(8, 8))
        s["run_state"].pack(side="left", fill="x", expand=True)
        self.run_state = s["run_state"]
        nb = ttk.Notebook(sec)
        nb.pack(fill="both", expand=True, pady=(10, 0))
        Tooltip(nb, lookup=self._tab_tip)
        self.tabs = nb
        self._tab_scorecard()
        self._tab_model()
        self._tab_eval()
        self._tab_live()

    def _section_heat(self) -> None:
        sec = self._new_section("heat")
        s = self._model_strip(sec, "Heat model: heat index in 1, 2 and 3 hours")
        self.heat_strip = s
        self.v_heat_start = tk.StringVar(value="2016-01-01")
        self.v_heat_train_on = tk.StringVar(value="forecast")
        self._setting(s["settings"], 0, "ERA5 history starts", self.v_heat_start, TIPS["heat_start"])
        self._setting(s["settings"], 1, "Learn from", self.v_heat_train_on, TIPS["heat_train_on"], 10, ["forecast", "era5"])
        a = s["actions"]
        self.btn_hdl = ttk.Button(a, text="1  Download heat data", command=lambda: self.run(["heat_dl"]))
        self.btn_htr = ttk.Button(a, text="2  Train and evaluate", command=lambda: self.run(["heat_train"]))
        self.btn_hall = ttk.Button(a, text="Run both steps", style="Accent.TButton", command=lambda: self.run(["heat_dl", "heat_train"]))
        self.btn_hstop = ttk.Button(a, text="Stop", command=self.stop, state="disabled")
        for b, k in ((self.btn_hdl, "b_hdl"), (self.btn_htr, "b_htr"), (self.btn_hall, "b_hall"), (self.btn_hstop, "b_stop")):
            b.pack(side="left", padx=(0, 8))
            Tooltip(b, TIPS[k])
        s["progress"].pack(side="left", padx=(8, 8))
        s["run_state"].pack(side="left", fill="x", expand=True)

        nb = ttk.Notebook(sec)
        nb.pack(fill="both", expand=True, pady=(10, 0))
        Tooltip(nb, lookup=self._tab_tip)
        self._tab_heat_live(nb)

        tab = ttk.Frame(nb, padding=14)
        nb.add(tab, text="Baselines")
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(0, weight=1)
        self.hb_tree = make_tree(tab, [("Horizon", 70, "w"), ("Method", 260, "w"), ("Deployable", 90, "center"), ("n", 70, "e"),
                                       ("MAE °C", 80, "e"), ("RMSE °C", 80, "e"), ("Bias °C", 80, "e"),
                                       ("Category accuracy", 130, "e")], height=14, heading_tips=HEAT_HEAD_TIPS)
        self.hb_tree.container.grid(row=0, column=0, sticky="nsew")  # type: ignore[attr-defined]
        ttk.Label(tab, text=TIPS["heat_deployable"], style="Muted.TLabel", wraplength=1000, justify="left"
                  ).grid(row=1, column=0, sticky="w", pady=(8, 0))

        tab = ttk.Frame(nb, padding=14)
        nb.add(tab, text="Error per horizon")
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(0, weight=1)
        self.h_chart_err = ChartPanel(tab)
        self.h_chart_err.grid(row=0, column=0, sticky="nsew")

        tab = ttk.Frame(nb, padding=14)
        nb.add(tab, text="Confusion matrix")
        tab.columnconfigure(0, weight=1)
        top = ttk.Frame(tab)
        top.grid(row=0, column=0, sticky="w", pady=(0, 8))
        ttk.Label(top, text="Horizon").pack(side="left")
        self.v_conf_h = tk.StringVar(value="+1 h")
        cb = ttk.Combobox(top, textvariable=self.v_conf_h, values=["+1 h", "+2 h", "+3 h"], width=6, state="readonly")
        cb.pack(side="left", padx=8)
        cb.bind("<<ComboboxSelected>>", lambda _e: self._fill_confusion())
        ttk.Label(top, text="Rows: real category (airport thermometer).  Columns: what the model predicted (forecast inputs).",
                  style="Muted.TLabel").pack(side="left", padx=(12, 0))
        self.hc_tree = make_tree(tab, [("Real \\ predicted", 150, "w")] + [(HEAT_LABELS[k], 120, "e") for k in CATEGORY_KEYS] +
                                 [("Recall", 80, "e")], height=5)
        self.hc_tree.container.grid(row=1, column=0, sticky="ew")  # type: ignore[attr-defined]
        self.hc_note = ttk.Label(tab, text="", wraplength=1000, justify="left")
        self.hc_note.grid(row=2, column=0, sticky="w", pady=(10, 0))

        tab = ttk.Frame(nb, padding=14)
        nb.add(tab, text="Model")
        tab.columnconfigure((0, 1), weight=1)
        tab.rowconfigure(1, weight=1)
        self.hm_info = make_tree(tab, [("Setting", 170, "w"), ("Value", 330, "w")], height=9)
        self.hm_info.container.grid(row=0, column=0, sticky="nsew", padx=(0, 10))  # type: ignore[attr-defined]
        self.hm_split = make_tree(tab, [("Split", 60, "w"), ("From", 100, "w"), ("To", 100, "w"), ("Rows", 80, "e")], height=3)
        self.hm_split.container.grid(row=0, column=1, sticky="new")  # type: ignore[attr-defined]
        self.hm_feat = make_tree(tab, [("Feature", 170, "w"), ("Weight +1 h", 100, "e"), ("Weight +2 h", 100, "e"),
                                       ("Weight +3 h", 100, "e")], height=10, heading_tips=FEATURE_HEAD_TIPS)
        self.hm_feat.container.grid(row=1, column=0, columnspan=2, sticky="nsew", pady=(10, 0))  # type: ignore[attr-defined]

    # ============================================================ history
    def _section_history(self) -> None:
        sec = self._new_section("history")
        self.history_loaded = False
        self.history_busy = False
        ttk.Label(sec, text="History: are the models working in real life?", style="H1.TLabel").pack(anchor="w")
        ttk.Label(sec, style="Muted.TLabel", wraplength=1100, justify="left", text=(
            "The app records every 20-minute weather refresh and later checks it against what the RPMZ airport reported "
            "(rain 20 minutes later; heat index from the airport's temperature and dew point at each target hour). "
            "The same numbers are on the admin console's Weather Dashboard.")).pack(anchor="w", pady=(2, 8))
        bar = ttk.Frame(sec)
        bar.pack(fill="x")
        ttk.Label(bar, text="Period").pack(side="left")
        self.v_hist_period = tk.StringVar(value="7 days")
        cb = ttk.Combobox(bar, textvariable=self.v_hist_period, values=list(HISTORY_PERIODS), width=9, state="readonly")
        cb.pack(side="left", padx=(6, 14))
        cb.bind("<<ComboboxSelected>>", lambda _e: self.load_history())
        ttk.Label(bar, text="Source").pack(side="left")
        self.v_hist_source = tk.StringVar(value="App (every 20 min)")
        cb2 = ttk.Combobox(bar, textvariable=self.v_hist_source, values=["App (every 20 min)", "This GUI's live runs"],
                           width=20, state="readonly")
        cb2.pack(side="left", padx=(6, 14))
        cb2.bind("<<ComboboxSelected>>", lambda _e: self.load_history())
        Tooltip(cb2, TIPS["hist_source"])
        self.btn_hist = ttk.Button(bar, text="Reload", command=self.load_history)
        self.btn_hist.pack(side="left")
        self.hist_status = ttk.Label(bar, text="", style="Muted.TLabel")
        self.hist_status.pack(side="left", padx=12)

        sf = ScrollFrame(sec)
        sf.pack(fill="both", expand=True, pady=(10, 0))
        inner = sf.inner
        inner.columnconfigure(0, weight=1)
        rb = ttk.LabelFrame(inner, text="Rain model: chance of rain in the next 20 minutes", padding=10)
        rb.grid(row=0, column=0, sticky="ew")
        self.hist_rain_stats = ttk.Label(rb, text="", wraplength=1100, justify="left")
        self.hist_rain_stats.pack(anchor="w", pady=(0, 6))
        self.hist_rain_chart = ChartPanel(rb, height=330)
        self.hist_rain_chart.pack(fill="x")
        hb = ttk.LabelFrame(inner, text="Heat model: heat index 1 to 3 hours ahead", padding=10)
        hb.grid(row=1, column=0, sticky="ew", pady=(12, 0))
        self.hist_heat_stats = ttk.Label(hb, text="", wraplength=1100, justify="left")
        self.hist_heat_stats.pack(anchor="w", pady=(0, 6))
        self.hist_heat_chart = ChartPanel(hb, height=330)
        self.hist_heat_chart.pack(fill="x")
        tb = ttk.LabelFrame(inner, text="Latest predictions (the numbers behind the charts)", padding=10)
        tb.grid(row=2, column=0, sticky="ew", pady=(12, 0))
        self.hist_tree = make_tree(tb, [("Time", 150, "w"), ("Rain chance", 90, "e"), ("Open-Meteo", 90, "e"),
                                        ("Rain mode", 110, "center"), ("Airport 20 min later", 140, "center"),
                                        ("Heat index now", 110, "e"), ("Model +1 h", 90, "e"), ("Open-Meteo +1 h", 110, "e"),
                                        ("Airport +1 h", 100, "e")], height=10)
        self.hist_tree.container.pack(fill="x")  # type: ignore[attr-defined]

    def load_history(self) -> None:
        if self.history_busy:
            return
        self.history_busy = True
        self.history_loaded = True
        days = HISTORY_PERIODS.get(self.v_hist_period.get(), 7)
        from_app = self.v_hist_source.get().startswith("App")
        self.btn_hist.config(state="disabled")
        self.hist_status.config(text="Loading ...", foreground=MUTED)
        threading.Thread(target=lambda: self.q.put(("history", self._history_worker(days, from_app))), daemon=True).start()

    @staticmethod
    def _history_worker(days: int, from_app: bool) -> dict:
        try:
            if not from_app:
                return summary_from_local_logs(days)
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            r = subprocess.run(["php", "artisan", "weather:history", f"--days={days}"], cwd=PROJECT, capture_output=True,
                               text=True, encoding="utf-8", errors="replace", timeout=60, creationflags=flags)
            if r.returncode != 0:
                return {"error": (r.stdout + r.stderr).strip()[-400:] or f"exit code {r.returncode}"}
            data = json.loads(r.stdout.strip().splitlines()[-1])
            data["source"] = "app"
            return data
        except FileNotFoundError:
            return {"error": "PHP is not on PATH, so the app's history cannot be read. Choose 'This GUI's live runs'."}
        except Exception as exc:  # parsing, timeouts: show it, do not crash the GUI
            return {"error": str(exc)}

    def _show_history(self, data: dict) -> None:
        self.history_busy = False
        self.btn_hist.config(state="normal")
        if "error" in data:
            self.hist_status.config(text=f"Could not load: {data['error']}", foreground=BAD)
            return
        src = "the app's record" if data.get("source") == "app" else "this GUI's live runs"
        self.hist_status.config(text=f"{data.get('count', 0)} predictions from {src}. Loaded {t12(datetime.now(), True)}.",
                                foreground=MUTED)
        rs = data["rain"].get("stats") or {}
        if rs.get("predictions"):
            caught = f"; rain caught {rs['caught']} of {rs['rain_reports']}" if rs.get("rain_reports") and "caught" in rs else ""
            om = f" (Open-Meteo {rs['brier_provider']:.3f})" if rs.get("brier_provider") is not None else ""
            err = f"probability error (Brier) {rs['brier_model']:.3f}{om}" if rs.get("brier_model") is not None else "no airport outcomes yet"
            self.hist_rain_stats.config(text=(f"{rs['predictions']} predictions, {rs.get('checked', 0)} checked against the airport: "
                                              f"{err}{caught}. Lower error is better."))
        else:
            self.hist_rain_stats.config(text=self._history_empty_text(data))
        hs = data["heat"].get("stats") or {}
        horizons = [h for h in hs.get("horizons", []) if h.get("checked")]
        if horizons:
            parts = [f"+{h['hours_ahead']} h: average error {h['mae_model']:.2f} °C"
                     + (f" (Open-Meteo {h['mae_provider']:.2f} °C)" if h.get("mae_provider") is not None else "")
                     + f" over {h['checked']}" for h in horizons]
            self.hist_heat_stats.config(text="Checked against the airport. " + "; ".join(parts) + ". Lower is better.")
        elif data["heat"].get("series"):
            self.hist_heat_stats.config(text=f"{len(data['heat']['series'])} predictions; no airport measurements matched yet.")
        else:
            self.hist_heat_stats.config(text=self._history_empty_text(data))
        self.hist_rain_chart.show(fig_history_rain(data))
        self.hist_heat_chart.show(fig_history_heat(data))
        deg = lambda v: "-" if v is None else f"{v:.1f} °C"
        pct = lambda v: "-" if v is None else f"{v:.0f}%"
        rows = []
        for r in data.get("recent", []):
            when = _local_times([r["time"]])[0]
            mode = ("On (raining now)" if r.get("raining_now") else "On") if r.get("rain_mode") else "Off"
            outcome = "-" if r.get("rain_outcome") is None else ("Rain" if r["rain_outcome"] else "Dry")
            rows.append((dt12(when), pct(r.get("rain_probability")), pct(r.get("provider_probability")), mode, outcome,
                         deg(r.get("heat_index_c")), deg(r.get("heat_plus1")), deg(r.get("heat_plus1_provider")),
                         deg(r.get("heat_plus1_observed"))))
        fill_tree(self.hist_tree, rows or [("No rows in this period.",) + ("",) * 8])

    @staticmethod
    def _history_empty_text(data: dict) -> str:
        if data.get("source") == "app":
            return ("No predictions recorded in this period yet. The app saves one every 20 minutes while the scheduler "
                    "runs (php artisan schedule:work), or once per 'php artisan weather:refresh'.")
        return "No live runs in this period. Use 'Run a live prediction now' in the Rain model or Heat model section."

    def _section_results(self) -> None:
        sec = self._new_section("results")
        sf = ScrollFrame(sec)
        sf.pack(fill="both", expand=True)
        inner = sf.inner
        inner.columnconfigure((0, 1), weight=1, uniform="res")
        ttk.Label(inner, text="Results: both models on data they never saw", style="H1.TLabel").grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(inner, style="Muted.TLabel", wraplength=1000, justify="left", text=(
            "Each model is scored once on its most recent, held-out period and compared with the simple methods the "
            "app could use instead. A model is only switched on if it beats all of them.")).grid(row=1, column=0, columnspan=2, sticky="w", pady=(2, 10))
        rb = ttk.LabelFrame(inner, text="Rain model (lower Brier is better)", padding=10)
        rb.grid(row=2, column=0, sticky="nsew", padx=(0, 8))
        hb = ttk.LabelFrame(inner, text="Heat model (lower error is better)", padding=10)
        hb.grid(row=2, column=1, sticky="nsew")
        self.res_rain_verdict = ttk.Label(rb, text="", style="H2.TLabel", wraplength=480, justify="left")
        self.res_rain_verdict.pack(anchor="w", pady=(0, 6))
        self.res_rain_tree = make_tree(rb, [("Method", 230, "w"), ("Brier", 70, "e"), ("AUC", 60, "e"), ("Recall", 60, "e")], height=5)
        self.res_rain_tree.container.pack(fill="x")  # type: ignore[attr-defined]
        self.res_rain_chart = ChartPanel(rb, height=280)
        self.res_rain_chart.pack(fill="x", pady=(8, 0))
        self.res_heat_verdict = ttk.Label(hb, text="", style="H2.TLabel", wraplength=480, justify="left")
        self.res_heat_verdict.pack(anchor="w", pady=(0, 6))
        self.res_heat_tree = make_tree(hb, [("Horizon", 60, "w"), ("Model MAE", 80, "e"), ("Best simple method", 180, "w"),
                                            ("Its MAE", 70, "e"), ("Category acc.", 90, "e")], height=5)
        self.res_heat_tree.container.pack(fill="x")  # type: ignore[attr-defined]
        self.res_heat_chart = ChartPanel(hb, height=280)
        self.res_heat_chart.pack(fill="x", pady=(8, 0))

    def _section_export(self) -> None:
        sec = self._new_section("export")
        sf = ScrollFrame(sec)
        sf.pack(fill="both", expand=True)
        inner = sf.inner
        inner.columnconfigure(0, weight=1)
        ttk.Label(inner, text="Export", style="H1.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(inner, style="Muted.TLabel", wraplength=1000, justify="left", text=(
            "Training writes the JSON files the server reads. The parity check runs the PHP and JavaScript tests that "
            "prove the server computes exactly what Python computed. Run it after every training run.")
                  ).grid(row=1, column=0, sticky="w", pady=(2, 10))
        ttk.Label(inner, text="Files the app reads", style="H2.TLabel").grid(row=2, column=0, sticky="w", pady=(0, 4))
        self.ex_tree = make_tree(inner, [("File", 260, "w"), ("Written", 160, "w"), ("Recommended", 100, "center"),
                                         ("Size", 80, "e"), ("SHA-256 (first 16)", 160, "w")], height=6)
        self.ex_tree.container.grid(row=3, column=0, sticky="ew")  # type: ignore[attr-defined]
        row = ttk.Frame(inner)
        row.grid(row=4, column=0, sticky="w", pady=(12, 0))
        self.btn_parity = ttk.Button(row, text="Run parity check", style="Accent.TButton", command=lambda: self.run(["parity_php", "parity_js", "parity_sat"]))
        self.btn_parity.pack(side="left", padx=(0, 8))
        Tooltip(self.btn_parity, TIPS["b_parity"])
        b = ttk.Button(row, text="Export rain evidence report", command=self.export_report)
        b.pack(side="left", padx=(0, 8))
        Tooltip(b, TIPS["h_export"])
        b = ttk.Button(row, text="Export heat evidence report", command=self.export_heat_report)
        b.pack(side="left", padx=(0, 8))
        Tooltip(b, TIPS["h_export_heat"])
        ttk.Button(row, text="Open reports folder", command=lambda: open_folder(REPORTS)).pack(side="left")
        self.ex_progress = ttk.Progressbar(inner, mode="indeterminate", length=200)
        self.ex_progress.grid(row=5, column=0, sticky="w", pady=(10, 0))
        self.ex_state = ttk.Label(inner, text="Parity check not run in this session.", style="Muted.TLabel", wraplength=1000, justify="left")
        self.ex_state.grid(row=6, column=0, sticky="w", pady=(4, 0))

    def _section_logs(self) -> None:
        sec = self._new_section("logs")
        top = ttk.Frame(sec)
        top.pack(fill="x", pady=(0, 6))
        ttk.Label(top, text="Logs", style="H1.TLabel").pack(side="left")
        ttk.Button(top, text="Clear", command=self._clear_log).pack(side="right")
        ttk.Button(top, text="Open last heat training log",
                   command=lambda: self._open_file(HEAT_TRAIN_LOG)).pack(side="right", padx=(0, 8))
        ttk.Button(top, text="Open last rain training log",
                   command=lambda: self._open_file(TRAIN_LOG)).pack(side="right", padx=(0, 8))
        ttk.Label(sec, text="Everything the download, training and parity steps print appears here as it happens.",
                  style="Muted.TLabel").pack(anchor="w", pady=(0, 6))
        logf = ttk.Frame(sec)
        logf.pack(fill="both", expand=True)
        logf.rowconfigure(0, weight=1)
        logf.columnconfigure(0, weight=1)
        self.log = tk.Text(logf, wrap="none", bg="#111827", fg="#e5e7eb", insertbackground="white",
                           font=("Consolas", 10) if os.name == "nt" else ("Courier", 10), state="disabled")
        ys = ttk.Scrollbar(logf, command=self.log.yview)
        xs = ttk.Scrollbar(logf, orient="horizontal", command=self.log.xview)
        self.log.configure(yscrollcommand=ys.set, xscrollcommand=xs.set)
        self.log.grid(row=0, column=0, sticky="nsew")
        ys.grid(row=0, column=1, sticky="ns")
        xs.grid(row=1, column=0, sticky="ew")

    def _clear_log(self) -> None:
        self.log.config(state="normal")
        self.log.delete("1.0", "end")
        self.log.config(state="disabled")

    def _open_file(self, path: Path) -> None:
        if not path.exists():
            messagebox.showinfo("Log", f"{path.name} does not exist yet. Train the model first.")
            return
        if os.name == "nt":
            os.startfile(path)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open" if sys.platform != "darwin" else "open", str(path)])

    # ========================================================= heat views
    def _refresh_heat(self) -> None:
        d = self.data
        hm, hx = self.heat_model, self.heat_metrics
        s = self.heat_strip

        # data status + dataset tab
        lines = []
        for name, path, df in (("ERA5 history", ERA5_CSV, d.heat_era5), ("Archived forecasts", FORECAST_CSV, d.heat_fc)):
            lines.append(f"[x]  {name}: {len(df):,} hours, {Dataset.span(df)}" if df is not None
                         else f"[ ]  {name}: not downloaded yet ({path.name})")
        lines.append(f"[x]  Model: heat_model.json written {hm['created']}, learned from {hm.get('train_on', '?')}"
                     if hm else "[ ]  Model: not trained yet")
        s["status"].config(text="\n".join(lines))
        if d.heat_era5 is not None:
            hi = d.heat_hi_era5
            self.hd_cards[0].set(fmt(len(d.heat_era5)), Dataset.span(d.heat_era5))
            self.hd_cards[2].set(f"{hi.mean():.1f} °C", f"average; highest {hi.max():.1f} °C")
            shares = hi.dropna().map(category).value_counts(normalize=True)
            self.hd_cards[3].set(f"{shares.get('caution', 0) * 100:.0f}% Caution",
                                 " / ".join(f"{HEAT_LABELS[k]} {shares.get(k, 0) * 100:.1f}%" for k in CATEGORY_KEYS if k != "caution"))
        else:
            for c in (self.hd_cards[0], self.hd_cards[2], self.hd_cards[3]):
                c.set("-", "not downloaded yet")
        self.hd_cards[1].set(fmt(len(d.heat_fc)) if d.heat_fc is not None else "-",
                             Dataset.span(d.heat_fc) if d.heat_fc is not None else "not downloaded yet")
        files = []
        for path, df in ((ERA5_CSV, d.heat_era5), (FORECAST_CSV, d.heat_fc)):
            if df is not None:
                files.append((path.name, f"{len(df):,}", Dataset.span(df), f"{df.isna().mean().mean() * 100:.1f}%",
                              human_size(path.stat().st_size)))
        fill_tree(self.hd_files, files or [("no heat data yet: Heat model > 1 Download heat data", "", "", "", "")])
        self.hd_chart.show(fig_heat_monthly(d.heat_hi_era5, d.heat_hi_fc))

        # verdict
        text, color = heat_verdict(hm, hx)
        s["verdict"].config(text=text, foreground=color)

        # baselines table
        rows = []
        if hx:
            for h, v in hx["horizons"].items():
                for k, m in v["results"].items():
                    rows.append((f"+{h} h", k, "yes" if k in HEAT_DEPLOYABLE else "no", fmt(m.get("n")), fmt(m.get("mae"), 2),
                                 fmt(m.get("rmse"), 2), f"{m['bias']:+.2f}" if m.get("bias") is not None else "-",
                                 f"{m['category_accuracy'] * 100:.1f}%" if m.get("category_accuracy") is not None else "-"))
        fill_tree(self.hb_tree, rows or [("", "No evaluation yet: train the heat model.", "", "", "", "", "", "")])
        self.h_chart_err.show(fig_heat_errors(hx))
        self._fill_confusion()

        # model tab
        if hm:
            ph = hm["per_horizon"]
            fill_tree(self.hm_info, [
                ("Model type", "Ridge regression per horizon (scored in plain PHP by HeatModel.php)"),
                ("Question answered", "Heat index (°C) 1, 2 and 3 hours after the current hour"),
                ("Learns from", "archived Open-Meteo forecasts" if hm.get("train_on") == "forecast" else "ERA5 reanalysis"),
                ("Labels", "heat index from ERA5 temperature and humidity at the target hour" if hm.get("labels", "era5") == "era5"
                 else "heat index the RPMZ airport thermometer reported at the target hour"),
                ("Ridge strength (alpha)", ", ".join(f"+{h} h: {v['alpha']}" for h, v in ph.items())),
                ("Features", str(len(hm["features"]))),
                ("Recommended", "yes" if hm.get("recommended") else "no"),
                ("Created (UTC)", hm["created"]),
                ("heat_model.json SHA-256", sha256_of(HEAT_MODEL_JSON)[:32] + "..."),
            ])
            fill_tree(self.hm_split, [(k, v[0], v[1], f"{v[2]:,}") for k, v in hm.get("periods", {}).items()])
            fill_tree(self.hm_feat, [(HEAT_FEATURE_LABELS.get(f, f), *(f"{ph[h]['coef'][i]:+.3f}" for h in ("1", "2", "3")))
                                     for i, f in enumerate(hm["features"])])
        else:
            for t in (self.hm_info, self.hm_split, self.hm_feat):
                fill_tree(t, [])

    def _fill_confusion(self) -> None:
        hx = self.heat_metrics
        h = self.v_conf_h.get().strip("+ h")
        res = (hx or {}).get("horizons", {}).get(h, {})
        key = res.get("deployed_key")
        m = res.get("results", {}).get(key) if key else None
        if not m or "confusion" not in m:
            fill_tree(self.hc_tree, [("no evaluation yet",) + ("",) * (len(CATEGORY_KEYS) + 1)])
            self.hc_note.config(text="")
            return
        conf = m["confusion"]
        rows = []
        for real in CATEGORY_KEYS:
            total = sum(conf[real].values())
            rec = f"{conf[real][real] / total * 100:.0f}%" if total else "no cases"
            rows.append((HEAT_LABELS[real], *(f"{conf[real][p]:,}" for p in CATEGORY_KEYS), rec))
        fill_tree(self.hc_tree, rows)
        self.hc_note.config(text=danger_note(m), foreground=AMBER if m.get("danger_or_above_recall") is None else "#111827")

    def _refresh_overview(self) -> None:
        rain_text = self.sc_verdict.cget("text") or "Not trained yet."
        heat_text, heat_color = heat_verdict(self.heat_model, self.heat_metrics)
        d = self.data
        rain_checks = [
            ("ok" if d.m15 is not None else "no", "Open-Meteo history downloaded" if d.m15 is not None else "Open-Meteo history missing"),
            ("ok" if d.metar is not None else "warn", "Airport (METAR) rain reports downloaded" if d.metar is not None else "METAR reports missing"),
            ("ok" if self.model else "no", f"model.json trained {self.model['created'][:10]}" if self.model else "model.json not trained"),
            ("ok" if (self.model or {}).get("recommended") else "warn", "Recommended (beats every simple method)"
             if (self.model or {}).get("recommended") else "Not recommended: app uses Open-Meteo's rain chance"),
            ("ok" if PARITY_JSON.exists() else "no", "Parity cases written (model_parity.json)"),
        ]
        hm = self.heat_model
        heat_checks = [
            ("ok" if d.heat_era5 is not None else "no", "ERA5 history downloaded" if d.heat_era5 is not None else "ERA5 history missing"),
            ("ok" if d.heat_fc is not None else "warn", "Archived forecasts downloaded" if d.heat_fc is not None else "Archived forecasts missing"),
            ("ok" if hm else "no", f"heat_model.json trained {hm['created'][:10]}" if hm else "heat_model.json not trained"),
            ("ok" if (hm or {}).get("recommended") else "warn", "Recommended (beats every simple method)"
             if (hm or {}).get("recommended") else "Not recommended: app uses the forecast heat index"),
            ("ok" if HEAT_PARITY_JSON.exists() else "no", "Parity cases written (heat_model_parity.json)"),
        ]
        sym = {"ok": ("✔", GOOD), "warn": ("⚠", AMBER), "no": ("✖", BAD)}
        for key, text, color, checks in (("rain", rain_text, self.sc_verdict.cget("foreground"), rain_checks),
                                         ("heat", heat_text, heat_color, heat_checks)):
            verdict, box = self.ov_boxes[key]
            verdict.config(text=text, foreground=color)
            for w in box.winfo_children():
                w.destroy()
            for status, line in checks:
                r = ttk.Frame(box)
                r.pack(anchor="w", pady=1)
                ttk.Label(r, text=sym[status][0], foreground=sym[status][1], width=2).pack(side="left")
                ttk.Label(r, text=line).pack(side="left")
        todo = []
        if d.m15 is None or d.metar is None or not self.model:
            todo.append("Rain model: press 'Run all steps' (about 10 minutes the first time).")
        if d.heat_era5 is None or not hm:
            todo.append("Heat model: press 'Run both steps' (about 3 minutes the first time).")
        todo.append("After any training run: Export > Run parity check, then copy the changed JSON files with the app.")
        self.ov_next.config(text="\n".join(f"• {t}" for t in todo))

    def _refresh_results(self) -> None:
        mt = self.metrics
        self.res_rain_verdict.config(text=self.sc_verdict.cget("text"), foreground=self.sc_verdict.cget("foreground"))
        rows = []
        if mt:
            for k, v in mt["results"].items():
                rows.append((k, fmt(v["brier"], 4), fmt(v["roc_auc"], 3), fmt(v["recall"], 3)))
        fill_tree(self.res_rain_tree, rows or [("not trained yet", "", "", "")])
        self.res_rain_chart.show(fig_compare(mt))
        text, color = heat_verdict(self.heat_model, self.heat_metrics)
        self.res_heat_verdict.config(text=text, foreground=color)
        fill_tree(self.res_heat_tree, heat_result_rows(self.heat_metrics) or [("not trained yet", "", "", "", "")])
        self.res_heat_chart.show(fig_heat_errors(self.heat_metrics, compact=True))

    def _refresh_export(self) -> None:
        rows = []
        for path in (MODEL_JSON, PARITY_JSON, HEAT_MODEL_JSON, HEAT_PARITY_JSON, GRID_FIXTURE):
            if path.exists():
                data = read_json(path) if path in (MODEL_JSON, HEAT_MODEL_JSON) else None
                rec = "-" if data is None else ("yes" if data.get("recommended") else "no")
                written = dt12(datetime.fromtimestamp(path.stat().st_mtime))
                rows.append((str(path.relative_to(PROJECT)).replace("\\", "/"), written, rec,
                             human_size(path.stat().st_size), sha256_of(path)[:16]))
            else:
                rows.append((str(path.relative_to(PROJECT)).replace("\\", "/"), "missing: train first", "-", "-", "-"))
        fill_tree(self.ex_tree, rows)

    def export_heat_report(self) -> None:
        hm, hx = self.heat_model, self.heat_metrics
        if not hm or not hx:
            messagebox.showinfo("Heat evidence report", "Train the heat model first, then export.")
            return
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        fig_heat_errors(hx).savefig(EVIDENCE / "heat_error_per_horizon.png", dpi=150)
        fig_heat_monthly(self.data.heat_hi_era5, self.data.heat_hi_fc).savefig(EVIDENCE / "heat_monthly.png", dpi=150)
        text, _ = heat_verdict(hm, hx)
        L = ["# Heat index model: evidence", "", f"Generated {dt12(datetime.now())} from the files in `ml/`. "
             "Full write-up: `ml/HEAT_REPORT.md`.", "", f"**Verdict:** {text}", "",
             f"- Learns from: {hm.get('train_on')}", f"- Created (UTC): {hm['created']}",
             f"- heat_model.json SHA-256: `{sha256_of(HEAT_MODEL_JSON)}`", "",
             "| Split | From | To | Rows |", "|---|---|---|---|"]
        L += [f"| {k} | {v[0]} | {v[1]} | {v[2]:,} |" for k, v in hm.get("periods", {}).items()]
        L += ["", "| Horizon | Method | n | MAE | RMSE | Bias | Category accuracy |", "|---|---|---|---|---|---|---|"]
        for h, v in hx["horizons"].items():
            for k, m in v["results"].items():
                L.append(f"| +{h} h | {k} | {m['n']:,} | {m['mae']:.2f} | {m['rmse']:.2f} | {m['bias']:+.2f} | "
                         f"{m['category_accuracy'] * 100:.1f}% |")
        L += ["", "![Error per horizon](heat_error_per_horizon.png)", "", "![Monthly heat index](heat_monthly.png)", "",
              "_Weather data by Open-Meteo.com (CC BY 4.0); ERA5: Copernicus Climate Change Service._"]
        out = EVIDENCE / "heat_evidence_report.md"
        out.write_text("\n".join(L) + "\n", encoding="utf-8")
        if messagebox.askyesno("Heat evidence report", f"Saved to:\n{out}\n\nOpen the folder?"):
            open_folder(EVIDENCE)

    # ------------------------------------------------------------- report
    def export_report(self) -> None:
        if not self.model or not self.metrics:
            messagebox.showinfo("Evidence report", "Train the model first, then export.")
            return
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        figs = {"openmeteo_monthly.png": fig_openmeteo_monthly(self.data.m15),
                "metar_monthly.png": fig_metar_monthly(self.data.metar),
                "model_weights.png": fig_coefficients(self.model),
                "brier_vs_baselines.png": fig_brier(self.metrics),
                "calibration.png": fig_calibration(self.metrics)}
        for name, fig in figs.items():
            fig.savefig(EVIDENCE / name, dpi=150)

        d, m, mt = self.data, self.model, self.metrics
        L = ["# Rain predictor: dataset and model evidence", "",
             f"Generated {dt12(datetime.now())} from the files in `ml/`. Campus point: {LAT}, {LON} (Zamboanga City).", "",
             f"_{ATTRIBUTION}_", "", "## 1. Dataset", "",
             "| File | Rows | Date range | Size | SHA-256 (first 16) |", "|---|---|---|---|---|"]
        for label, path, df in (("openmeteo_minutely15.csv", M15_CSV, d.m15), ("openmeteo_hourly.csv", HOURLY_CSV, d.hourly)):
            if df is not None:
                L.append(f"| {label} | {len(df):,} | {Dataset.span(df)} | {human_size(path.stat().st_size)} | `{sha256_of(path)[:16]}` |")
        if d.metar is not None:
            L.append(f"| metar.csv | {len(d.metar):,} | {d.metar['time'].min():%Y-%m-%d} to {d.metar['time'].max():%Y-%m-%d} | "
                     f"{human_size(METAR_CSV.stat().st_size)} | `{sha256_of(METAR_CSV)[:16]}` |")
            L += ["", f"METAR observations are real airport reports; {d.metar['rain'].mean() * 100:.1f}% of them report rain."]
        L += ["", "![Open-Meteo monthly precipitation](openmeteo_monthly.png)", "", "![METAR rain share](metar_monthly.png)", "",
              "## 2. Model", "", f"- Type: logistic regression, scored in plain PHP (`RainModel.php`)",
              f"- Question: rain within {m['horizon_minutes']} minutes at the campus point",
              f"- Label source: {m['label_source']}", f"- Features: {len(m['features'])}",
              f"- Regularisation C: {m['C']}", f"- Alert threshold: {m['alert_threshold']}",
              f"- Created (UTC): {m['created']}", f"- model.json SHA-256: `{sha256_of(MODEL_JSON)}`",
              f"- Recommended by the evaluation: **{'yes' if m.get('recommended') else 'no'}**", ""]
        splits = read_split_log()
        if splits:
            L += ["| Split | From | To | Rows | Rain rate | Months |", "|---|---|---|---|---|---|"]
            L += [f"| {s['split']} | {s['start']} | {s['end']} | {s['rows']:,} | {s['rain']:.3f} | {s['months']} |" for s in splits]
            L.append("")
        L += ["Splits are chronological (never random); the test period is scored once.", "",
              "![Model weights](model_weights.png)", "", "## 3. Test-period results", "",
              "| Model | n | Rain rate | Brier | AUC | Precision | Recall | Rain starts caught | False alarm ratio |",
              "|---|---|---|---|---|---|---|---|---|"]
        for k, v in mt["results"].items():
            L.append(f"| {k} | {v['n']:,} | {fmt(v['rain_rate'])} | {fmt(v['brier'], 5)} | {fmt(v['roc_auc'])} | "
                     f"{fmt(v['precision'])} | {fmt(v['recall'])} | {fmt(v.get('start_recall'))} | {fmt(v['false_alarm_ratio'])} |")
        L += ["", "![Brier vs baselines](brier_vs_baselines.png)", "", "![Calibration](calibration.png)", "",
              "## 4. Limitations", "",
              "- Open-Meteo values outside Europe and North America are interpolated from hourly model output.",
              "- Offline scores are slightly optimistic: the archive is stitched from forecast runs.",
              "- Validation and test periods cover less than a year, so the wet/dry cycle is only partly represented.",
              "- Airport-report inputs only use reports issued at least 10 minutes before each moment, as the app receives them.",
              "- Multi-model inputs come from archived forecasts (from 2024), stitched like the main archive.",
              "- The airport station is close to, but not at, the campus."]
        out = EVIDENCE / "evidence_report.md"
        out.write_text("\n".join(L) + "\n", encoding="utf-8")
        if messagebox.askyesno("Evidence report", f"Saved to:\n{out}\n\nOpen the folder?"):
            open_folder(EVIDENCE)


if __name__ == "__main__":
    App().mainloop()
