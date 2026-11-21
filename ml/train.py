"""Train and honestly evaluate the AR-Node rain predictor (default: 20 minutes ahead).

    python download_openmeteo.py --start 2022-01-01
    python download_metar.py     --start 2022-01-01     # optional, real observations
    python train.py                                       # auto: METAR labels if present

Question answered: "will it rain (>= 0.1 mm) in the next 20 minutes at the campus?"

Label sources
  metar      real observed rain at the airport (present-weather RA/DZ/SH/TS), taken
             from the report nearest to t+20 min (within +-15 min). BEST truth, sparse.
  openmeteo  precipitation of the stitched Open-Meteo series over (t, t+20 min],
             assuming even intensity inside each 15-min step. Model data, not
             observations: scores can look better than reality. Say so in your report.

Inputs (compared as variants, the best on VALIDATION is exported unless --variant says otherwise)
  forecast    Open-Meteo best-match forecast for the campus point (always)
  airport     + the latest airport report issued at least 10 minutes before t (common.py
              build_obs_features): raining, thunder, storm clouds, lightning, recent rain
  multimodel  + agreement between 9 forecast models (download_multimodel.py)
  both        + both of the above
  satellite   + Himawari cloud tops around campus (download_satellite.py), on top of the
              richest set above. When it is exported, the best set WITHOUT satellite is
              exported too ("fallback"), so the app still scores a model when a scan is missing.

Everything is split by TIME (never randomly). The test period is scored once.
The exported model is a logistic regression, or gradient-boosted trees when they lower the validation
Brier by at least TREE_MIN_GAIN (the simpler model wins a near-tie: in Nov 2026 trees won validation by
0.3% and then lost on the test period). Both are scored in plain PHP. A Platt calibration fitted on the
validation period is added when a two-fold check on that period shows it helps.
It is only marked "recommended" if it beats every deployable baseline on the test
period, otherwise the app must keep using the raw Open-Meteo probability.
The alert threshold is chosen on the validation period (best F2 score: a missed
shower costs more than a false alarm) unless --alert gives a number.
"start_recall" = share of RAIN STARTS caught (rain at t+20 min while the latest airport
report was dry): the heads-up students need, and the hardest case.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

from common import (HOURLY_CSV, M15_CSV, METAR_CSV, MM_FEATURES, MM_MIN_MODELS, MM_MODELS, MM_VARS, MM_WET_MM,
                    MODEL_JSON, MULTIMODEL_CSV, OBS_FEATURES, OBS_FRESH_MIN, OBS_LAG_MIN, OBS_MAX_AGE_MIN,
                    OBS_RECENT_MIN, PARITY_JSON, REPORTS, SAT_B10_CSV, SAT_COOLING_MIN, SAT_CSV, SAT_FEATURES, SAT_LAG_MIN,
                    SAT_MAX_AGE_MIN, SAT_MOTION_CSV, SAT_PHASE_CSV, STEP, TZ, build_features, build_multimodel_features, build_obs_features,
                    INPUT_DECIMALS, MOTION_FEATURES, build_sat_features, metar_reports, model_probability, read_motion,
                    read_phase, read_satellite, read_series)
from cloud_phase import CLOUD_FEATURES
from satellite import ATTRIBUTION as SAT_ATTRIBUTION, BAND as SAT_BAND, COLD_C as SAT_COLD_C, WV_BAND as SAT_WV_BAND

RAIN_WX = re.compile(r"(RA|DZ|SH|TS|UP)")
SAT_MIN_GAIN = 0.005  # satellite must lower validation Brier by at least 0.5% to be exported
SAT_MIN_MONTHS = 12   # less satellite history than this: train without it (download still running)
TREE_MIN_GAIN = 0.005  # trees must lower validation Brier by at least 0.5% over the logistic regression
PROB_BINS = [0, .05, .1, .2, .3, .4, .5, .6, .8, 1.0001]


# ----------------------------------------------------------------- labels
def label_openmeteo(m15: pd.DataFrame, horizon: int, thr_mm: float) -> pd.Series:
    p = m15["precipitation"].asfreq("15min")
    full, rem = divmod(horizon, 15)
    window = sum(p.shift(-k) for k in range(1, full + 1))
    if rem:
        window = window + p.shift(-(full + 1)) * (rem / 15.0)
    return (window >= thr_mm).astype(float).where(window.notna())


def metar_rain_flag(wx) -> float:
    if pd.isna(wx):
        return 0.0
    for tok in str(wx).split():
        if tok.startswith(("VC", "RE")):   # vicinity / recent = not at the station now
            continue
        if RAIN_WX.search(tok.lstrip("+-")):
            return 1.0
    return 0.0


def load_metar() -> pd.DataFrame:
    df = pd.read_csv(METAR_CSV, dtype={"wxcodes": str})
    t = pd.to_datetime(df["valid"], utc=True).dt.tz_convert(TZ).dt.tz_localize(None)
    return pd.DataFrame({"time": t, "rain": df["wxcodes"].map(metar_rain_flag)}).sort_values("time")


def window_obs(grid: pd.DatetimeIndex, obs: pd.DataFrame, minutes: int) -> pd.Series:
    """1 if ANY airport report in (t, t + minutes] says rain, 0 if the reports there are all dry, NaN with none.

    The label of the 60-minute model ("rain at some point within the hour"). Every routine step has the
    hourly report in its window, so no step is labelled only by the extra (special) reports.
    """
    obs = obs.sort_values("time")
    times = obs["time"].astype("datetime64[ns]").to_numpy()
    cum = np.concatenate([[0.0], np.cumsum(obs["rain"].to_numpy())])
    g = grid.astype("datetime64[ns]").to_numpy()
    lo = np.searchsorted(times, g, side="right")
    hi = np.searchsorted(times, g + np.timedelta64(minutes, "m"), side="right")
    return pd.Series(np.where(hi > lo, (cum[hi] - cum[lo] > 0).astype(float), np.nan), index=grid)


def nearest_obs(grid: pd.DatetimeIndex, obs: pd.DataFrame, shift: pd.Timedelta, tol_min: int = 15) -> pd.Series:
    left = pd.DataFrame({"t": grid, "target": grid + shift}).sort_values("target")
    left["target"] = left["target"].astype("datetime64[ns]")
    obs = obs.assign(time=obs["time"].astype("datetime64[ns]"))
    out = pd.merge_asof(left, obs, left_on="target", right_on="time", direction="nearest",
                        tolerance=pd.Timedelta(minutes=tol_min))
    return pd.Series(out["rain"].to_numpy(), index=pd.DatetimeIndex(out["t"])).sort_index()


# ---------------------------------------------------------------- metrics
def metrics(y: np.ndarray, p: np.ndarray, thr: float, starts: np.ndarray | None = None) -> dict:
    """starts = mask of rain-start rows (rain while the latest airport report was dry) for start_recall."""
    p = np.clip(p, 1e-6, 1 - 1e-6)
    pred = p >= thr
    tp = int(((pred) & (y == 1)).sum()); fp = int(((pred) & (y == 0)).sum())
    fn = int(((~pred) & (y == 1)).sum()); tn = int(((~pred) & (y == 0)).sum())
    return {
        "n": int(len(y)), "rain_rate": round(float(y.mean()), 4),
        "brier": round(float(brier_score_loss(y, p)), 5),
        "log_loss": round(float(log_loss(y, p, labels=[0, 1])), 5),
        "roc_auc": round(float(roc_auc_score(y, p)), 4) if len(set(y)) > 1 else None,
        "precision": round(tp / (tp + fp), 4) if tp + fp else None,
        "recall": round(tp / (tp + fn), 4) if tp + fn else None,
        "false_alarm_ratio": round(fp / (tp + fp), 4) if tp + fp else None,   # of all alarms, share that were wrong
        "false_positive_rate": round(fp / (fp + tn), 4) if fp + tn else None,  # of dry cases, share alarmed
        "start_recall": round(float(pred[starts].mean()), 4) if starts is not None and starts.any() else None,
        "starts": int(starts.sum()) if starts is not None else None,
    }


def calibration(y: np.ndarray, p: np.ndarray) -> list[dict]:
    rows = []
    for lo, hi in zip(PROB_BINS[:-1], PROB_BINS[1:]):
        m = (p >= lo) & (p < hi)
        if m.any():
            rows.append({"bin": f"{lo:.2f}-{min(hi, 1):.2f}", "n": int(m.sum()),
                         "mean_pred": round(float(p[m].mean()), 4), "observed": round(float(y[m].mean()), 4)})
    return rows


VARIANT_NAMES = {"forecast": "forecast only", "airport": "forecast + airport report",
                 "multimodel": "forecast + several models", "both": "forecast + airport report + several models",
                 "satellite": "all of the above + satellite",
                 "motion": "all of the above + satellite + cloud motion",
                 "phase": "all of the above + satellite + cloud phase"}
SAT_VARIANTS = ("satellite", "motion", "phase")
# Extra satellite products: (variant, the command that fills its history)
SAT_EXTRAS = (("motion", "download_satellite.py --motion"), ("phase", "download_satellite.py --cloud"))


def load_metar_reports() -> tuple[pd.DataFrame, pd.Series]:
    """Airport reports as feature flags, plus the raw text per (minute) time for the parity cases."""
    df = pd.read_csv(METAR_CSV, dtype=str)
    t = pd.to_datetime(df["valid"], utc=True).dt.tz_convert(TZ).dt.tz_localize(None).dt.floor("min")
    raw = pd.Series(df["metar"].to_numpy(), index=t)
    raw = raw[~raw.index.duplicated(keep="last")].sort_index()
    return metar_reports(t, df["metar"]), raw


def choose_threshold(y: np.ndarray, p: np.ndarray) -> float:
    """Alert threshold with the best F2 score: catching a shower counts twice as much as avoiding a false alarm."""
    best_f2, best_thr = -1.0, 0.5
    for thr in np.round(np.arange(0.05, 0.81, 0.01), 2):
        warn = p >= thr
        tp = float((warn & (y == 1)).sum())
        if tp == 0:
            continue
        precision = tp / float(warn.sum())
        recall = tp / float((y == 1).sum())
        f2 = 5 * precision * recall / (4 * precision + recall)
        if f2 > best_f2:
            best_f2, best_thr = f2, float(thr)
    return best_thr


def fit_logistic(tr: pd.DataFrame, va: pd.DataFrame, cols: list[str]) -> dict:
    """Standardise, then pick C by validation Brier."""
    scaler = StandardScaler().fit(tr[cols].to_numpy())
    best = None
    for C in (0.01, 0.1, 1.0, 10.0):
        lr = LogisticRegression(C=C, max_iter=3000).fit(scaler.transform(tr[cols].to_numpy()), tr.y)
        b = brier_score_loss(va.y, lr.predict_proba(scaler.transform(va[cols].to_numpy()))[:, 1])
        if best is None or b < best[0]:
            best = (b, C, lr)
    b, C, lr = best

    def predict(part: pd.DataFrame) -> np.ndarray:
        return lr.predict_proba(scaler.transform(part[cols].to_numpy()))[:, 1]

    return {"cols": cols, "C": C, "lr": lr, "scaler": scaler, "val_brier": float(b), "predict": predict}


# Gradient-boosted trees: a few settings, picked on the validation period like the logistic C.
TREE_GRID = [(3, 0.05, 200), (3, 0.05, 400), (4, 0.05, 300)]


def fit_trees(tr: pd.DataFrame, va: pd.DataFrame, cols: list[str]) -> dict:
    best = None
    for depth, rate, iters in TREE_GRID:
        m = HistGradientBoostingClassifier(max_depth=depth, learning_rate=rate, max_iter=iters, random_state=0).fit(tr[cols].to_numpy(), tr.y)
        b = brier_score_loss(va.y, m.predict_proba(va[cols].to_numpy())[:, 1])
        if best is None or b < best[0]:
            best = (b, (depth, rate, iters), m)
    b, params, m = best
    return {"cols": cols, "model": m, "params": params, "val_brier": float(b)}


def raw_logit(kind: str, fit: dict, part: pd.DataFrame) -> np.ndarray:
    x = part[fit["cols"]].to_numpy()
    return fit["model"].decision_function(x) if kind == "trees" else fit["lr"].decision_function(fit["scaler"].transform(x))


def export_of(kind: str, fit: dict) -> dict:
    """What model.json stores for this model (common.model_logit and RainModel.php read it)."""
    if kind == "logistic":
        lr, sc = fit["lr"], fit["scaler"]
        return {"kind": "logistic", "features": fit["cols"], "mean": sc.mean_.tolist(), "scale": sc.scale_.tolist(),
                "coef": lr.coef_[0].tolist(), "intercept": float(lr.intercept_[0]), "C": fit["C"]}
    m, trees = fit["model"], []
    for (pred,) in m._predictors:  # one binary-classification tree per boosting round
        n = pred.nodes
        leaf = n["is_leaf"].astype(bool)
        trees.append({"f": [-1 if lf else int(f) for f, lf in zip(n["feature_idx"], leaf)],
                      "t": [0.0 if lf else float(t) for t, lf in zip(n["num_threshold"], leaf)],
                      "l": [int(v) for v in n["left"]], "r": [int(v) for v in n["right"]],
                      "v": [float(v) if lf else 0.0 for v, lf in zip(n["value"], leaf)]})
    depth, rate, iters = fit["params"]
    return {"kind": "trees", "features": fit["cols"], "baseline": float(np.ravel(m._baseline_prediction)[0]), "trees": trees,
            "tree_params": {"max_depth": depth, "learning_rate": rate, "max_iter": iters, "trees": len(trees)}}


def platt(z: np.ndarray, y: np.ndarray) -> dict:
    c = LogisticRegression(C=1e6, max_iter=1000).fit(z.reshape(-1, 1), y)
    return {"a": float(c.coef_[0][0]), "b": float(c.intercept_[0])}


def calibration_helps(z: np.ndarray, y: np.ndarray) -> bool:
    """Two-fold check on the validation period (first half / second half in time): a correction fitted on
    one half must lower the Brier score on the OTHER half, so it is never judged on data it was fitted on."""
    h = len(z) // 2
    sig = lambda v: 1.0 / (1.0 + np.exp(-v))
    raw = corrected = 0.0
    for fit_part, use_part in ((slice(0, h), slice(h, None)), (slice(h, None), slice(0, h))):
        if len(set(y[fit_part])) < 2:
            return False
        c = platt(z[fit_part], y[fit_part])
        raw += brier_score_loss(y[use_part], sig(z[use_part]))
        corrected += brier_score_loss(y[use_part], sig(c["a"] * z[use_part] + c["b"]))
    return corrected < raw


def choose_export(lr_fit: dict, tr: pd.DataFrame, va: pd.DataFrame, label: str, want: str = "auto") -> tuple[dict, callable, dict]:
    """Logistic, or trees on the same inputs if they clearly win on validation (want = "auto"), or the kind
    asked for (--kind), then calibration if it helps."""
    tree_fit = fit_trees(tr, va, lr_fit["cols"])
    trees_win = tree_fit["val_brier"] < lr_fit["val_brier"] * (1 - TREE_MIN_GAIN)
    kind = want if want != "auto" else "trees" if trees_win else "logistic"
    fit = tree_fit if kind == "trees" else lr_fit
    yv, zv = va.y.to_numpy(), raw_logit(kind, fit, va)
    export = export_of(kind, fit)
    if calibration_helps(zv, yv):
        export["calibration"] = platt(zv, yv)
    cal = export.get("calibration")

    def predict(part: pd.DataFrame) -> np.ndarray:
        z = raw_logit(kind, fit, part)
        return 1.0 / (1.0 + np.exp(-(cal["a"] * z + cal["b"] if cal else z)))

    print(f"{label}: validation Brier logistic {lr_fit['val_brier']:.5f}, trees {tree_fit['val_brier']:.5f} "
          f"(depth/rate/rounds {tree_fit['params']}) -> {kind}"
          + (" (set by --kind)" if want != "auto" else
             " (trees not better by the required 0.5%)" if kind == "logistic" and tree_fit["val_brier"] < lr_fit["val_brier"] else "")
          + (f", calibrated (a={cal['a']:.3f}, b={cal['b']:+.3f})" if cal else ", not calibrated (it did not help on validation)"))
    return export, predict, tree_fit


def importance(predict, va: pd.DataFrame, cols: list[str]) -> list[float]:
    """How much the validation Brier worsens when one input is shuffled (trees have no single weight)."""
    rng, y = np.random.default_rng(0), va.y.to_numpy()
    base = brier_score_loss(y, predict(va))
    out = []
    for c in cols:
        shuffled = va.copy()
        shuffled[c] = rng.permutation(shuffled[c].to_numpy())
        out.append(round(float(brier_score_loss(y, predict(shuffled)) - base), 6))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", choices=["auto", "metar", "openmeteo"], default="auto")
    ap.add_argument("--horizon", type=int, default=20, help="minutes ahead (default 20); other horizons write model_h<N>.json")
    ap.add_argument("--within", action="store_true",
                    help="label = rain in ANY airport report within the next HORIZON minutes (needed for horizons other than 20)")
    ap.add_argument("--compare", nargs="*", default=[], metavar="MODEL_JSON",
                    help="also score these saved models (e.g. a backup of the live one) on this run's test steps, "
                         "each at its own alert threshold: a like-for-like benchmark")
    ap.add_argument("--kind", choices=["auto", "logistic", "trees"], default="logistic",
                    help="model type (default logistic, as in gui.py); auto = logistic unless trees clearly win on validation")
    ap.add_argument("--threshold-mm", type=float, default=0.1, help="rain if at least this many mm (openmeteo label)")
    ap.add_argument("--alert", default="auto",
                    help="probability that turns rain mode on; 'auto' = best F2 score on the validation period")
    ap.add_argument("--variant", choices=["auto", *VARIANT_NAMES], default="auto",
                    help="which inputs to export; auto = lowest validation Brier")
    ap.add_argument("--train-end", help="last day of training, e.g. 2024-06-30 (default: first 70%% of time)")
    ap.add_argument("--val-end", help="last day of validation (default: next 15%%)")
    ap.add_argument("--drop", default="", help="comma list of features to leave out (e.g. precip_prob_next_hour,fcst_precip_next_hour)")
    ap.add_argument("--station", default="RPMZ", help="airport station (labels and the airport-report inputs)")
    ap.add_argument("--no-satellite", action="store_true", help="ignore the satellite history even if it exists")
    ap.add_argument("--sequence", action="store_true",
                    help="experiment: compare a GRU on the last 2 hours of inputs with the logistic regression "
                         "(sequence_model.py, needs torch); writes reports/sequence_comparison.json, exports nothing")
    a = ap.parse_args()
    if a.alert != "auto":
        try:
            assert 0 < float(a.alert) < 1
        except (ValueError, AssertionError):
            sys.exit("--alert must be 'auto' or a number between 0 and 1")

    # The 20-minute model is model.json; any other horizon gets its own files, so neither overwrites the other.
    sfx = "" if a.horizon == 20 else f"_h{a.horizon}"
    model_json, parity_json = MODEL_JSON.with_name(f"model{sfx}.json"), PARITY_JSON.with_name(f"model{sfx}_parity.json")

    for f in (M15_CSV, HOURLY_CSV):
        if not f.exists():
            sys.exit(f"Missing {f}. Run download_openmeteo.py first.")
    m15, hourly = read_series(M15_CSV), read_series(HOURLY_CSV)
    feats = build_features(m15, hourly)

    source = a.label if a.label != "auto" else ("metar" if METAR_CSV.exists() else "openmeteo")
    obs = None
    if source == "metar":
        if not METAR_CSV.exists():
            sys.exit(f"Missing {METAR_CSV}. Run download_metar.py or use --label openmeteo.")
        obs = load_metar()
        if a.within:
            y = window_obs(feats.index, obs, a.horizon)
            label_name = f"metar:{a.station} (rain in any report within the next {a.horizon} min)"
        elif a.horizon != 20:
            # The routine report is on the hour: t+60 from a :30/:45 step is 15-30 min from any routine
            # report, so only the special reports (mostly rain) would label it.
            sys.exit("Horizons other than 20 minutes need --within (rain at any time in the window).")
        else:
            y = nearest_obs(feats.index, obs, pd.Timedelta(minutes=a.horizon))
            label_name = f"metar:{a.station} (nearest report to t+{a.horizon} min, +-15 min)"
    else:
        y = label_openmeteo(m15, a.horizon, a.threshold_mm)
        label_name = f"openmeteo (>= {a.threshold_mm} mm in the next {a.horizon} min, model data)"

    # Drop features the API did not provide for this location, plus --drop.
    empty = [c for c in feats.columns if feats[c].isna().all()]
    if empty:
        print("Dropping features with no data:", empty)
    drop = set(empty) | {c.strip() for c in a.drop.split(",") if c.strip()}
    base_cols = [c for c in feats.columns if c not in drop]

    # ----- extra inputs
    parts = [feats[base_cols]]
    variants = {"forecast": base_cols}
    raw_reports = obs_feats = mm = None
    if METAR_CSV.exists():
        reports, raw_reports = load_metar_reports()
        obs_feats = build_obs_features(feats.index, reports)
        parts.append(obs_feats)
        variants["airport"] = base_cols + [c for c in OBS_FEATURES if c not in drop]
    else:
        print("No airport reports (data/metar.csv): skipping the airport-report inputs.")
    if MULTIMODEL_CSV.exists():
        mm = read_series(MULTIMODEL_CSV)
        parts.append(build_multimodel_features(feats.index, mm))
        variants["multimodel"] = base_cols + [c for c in MM_FEATURES if c not in drop]
    else:
        print("No multi-model forecasts (data/openmeteo_multimodel_hourly.csv): run download_multimodel.py to compare them.")
    if "airport" in variants and "multimodel" in variants:
        variants["both"] = list(dict.fromkeys(variants["airport"] + variants["multimodel"]))
    sat_rows = None
    if SAT_CSV.exists() and not SAT_B10_CSV.exists() and not a.no_satellite:
        print("Satellite cloud tops found but no water-vapour history (data/satellite_b10.csv): run 2b Download "
              "satellite again (it resumes and adds band 10). Training without satellite for now.")
    elif SAT_CSV.exists() and not a.no_satellite:
        scans = read_satellite()
        motion = read_motion() if SAT_MOTION_CSV.exists() else None
        phase = read_phase() if SAT_PHASE_CSV.exists() else None
        sat = build_sat_features(feats.index, scans, read_satellite(SAT_B10_CSV), m15["wind_direction_10m"].asfreq("15min"),
                                 motion, phase)
        extras = {"motion": (motion, MOTION_FEATURES), "phase": (phase, CLOUD_FEATURES)}
        for name, how in SAT_EXTRAS:
            data, extra_cols = extras[name]
            if data is None:
                continue
            # An extra product only counts if its history covers the satellite steps; otherwise it would shrink every variant.
            sat_only = sat[SAT_FEATURES].dropna()
            covered = sat.loc[sat_only.index, extra_cols].notna().all(axis=1)
            # Never NaN (a missing scan is an input): count the steps that really have one.
            if name == "phase":
                covered &= sat.loc[sat_only.index, "sat_phase_missing"].eq(0)
            if name == "motion":
                covered &= sat.loc[sat_only.index, "sat_motion_missing"].eq(0)
            labelled = covered.index[y.reindex(covered.index).notna().to_numpy()]
            share = float(covered.reindex(labelled).mean()) if len(labelled) else 0.0
            # Cloud phase: NOAA's archive has no phase files from 12 Oct to 25 Nov 2025 (checked Nov 2026), so 91%
            # is all there is; those steps stay in, with sat_phase_missing = 1.
            # Cloud motion: the full history is ~140 GB, so download_satellite.py --every 8 keeps 1 scan in 8
            # (about 12% of the steps); the rest read sat_motion_missing = 1. It still has to beat the 0.5% rule.
            need = {"phase": 0.90, "motion": 0.10}.get(name, 0.98)
            if share < need:
                print(f"{VARIANT_NAMES[name]}: covers {share:.0%} of the labelled satellite steps ({need:.0%} needed): skipped. "
                      f"Let {how} finish, then train again.")
                sat = sat.drop(columns=extra_cols)
                extras[name] = (None, extra_cols)
            else:
                print(f"{VARIANT_NAMES[name]}: {len(data):,} scans, {share:.1%} of the labelled satellite steps.")
        have = sat.dropna()
        sat_rows = int(len(have))
        # Only labelled steps count: a half-finished download must not shrink training to a few months.
        labelled = have.index[y.reindex(have.index).notna().to_numpy()]
        sat_months = labelled.to_period("M").nunique()
        if sat_rows and sat_months < SAT_MIN_MONTHS:
            print(f"Satellite covers only {sat_months} month(s) of labelled steps (at least {SAT_MIN_MONTHS} needed): "
                  "skipped. Let download_satellite.py finish, then train again.")
        elif sat_rows:
            print(f"Satellite: {len(scans):,} scans -> inputs for {sat_rows:,} of {len(sat):,} steps "
                  f"({have.index.min():%Y-%m-%d} to {have.index.max():%Y-%m-%d}). Every variant is fitted on "
                  "the steps that HAVE satellite inputs, so the comparison stays fair.")
            parts.append(sat)
            richest = variants.get("both") or variants.get("airport") or variants["forecast"]
            variants["satellite"] = richest + [c for c in SAT_FEATURES if c not in drop]
            for name, (data, extra_cols) in extras.items():
                if data is not None:
                    variants[name] = variants["satellite"] + [c for c in extra_cols if c not in drop]
        else:
            print("Satellite history has no scans inside the forecast period: skipped.")
    elif not a.no_satellite:
        print("No satellite history (data/satellite_b13.csv): run download_satellite.py to compare it.")
    if a.variant != "auto" and a.variant not in variants:
        sys.exit(f"--variant {a.variant} needs data that is not downloaded yet.")

    allf = pd.concat(parts, axis=1)
    used = list(dict.fromkeys(c for cols in variants.values() for c in cols))
    # Every variant is fitted and scored on the SAME rows, so the comparison is fair.
    # Inputs rounded to INPUT_DECIMALS (common.py): PHP's sin() or a sum in another order differ from
    # numpy in the 16th digit, which flipped tree splits sitting exactly on a value (whole-degree wind).
    df = allf[used].round(INPUT_DECIMALS).join(y.rename("y")).dropna()
    # Only steps labelled by the ROUTINE hourly airport report (minutes :30 and :45). The :00/:15 steps
    # get a label only from extra (special) reports, which the airport issues when the weather changes:
    # 96-98% of them are rain, against 7% overall, so they taught "this time of the hour = rain" and
    # made the test look easier than real life. The app still predicts at every step.
    df = df[df.index.minute.isin([30, 45])]
    df["y"] = df["y"].astype(int)
    if len(df) < 2000:
        sys.exit(f"Only {len(df)} usable rows - download more history first.")

    # Baseline inputs (computed from the full feature table, aligned to df rows).
    base = pd.DataFrame(index=df.index)
    base["persistence"] = (feats["precip_0"] >= a.threshold_mm).astype(float).reindex(df.index)
    if obs_feats is not None:
        base["airport_latest"] = obs_feats["obs_rain"].reindex(df.index)
    if "precip_prob_next_hour" in feats and not feats["precip_prob_next_hour"].isna().all():
        base["raw_provider"] = (feats["precip_prob_next_hour"] / 100.0).reindex(df.index)

    # ----- chronological split
    idx = df.index
    t_end = pd.Timestamp(a.train_end) + pd.Timedelta(days=1) if a.train_end else idx[int(len(idx) * 0.70)]
    v_end = pd.Timestamp(a.val_end) + pd.Timedelta(days=1) if a.val_end else idx[int(len(idx) * 0.85)]
    tr, va, te = df[idx < t_end], df[(idx >= t_end) & (idx < v_end)], df[idx >= v_end]
    print(f"\nlabel: {label_name}")
    for name, part in (("train", tr), ("val", va), ("test", te)):
        months = part.index.to_period("M").nunique()
        print(f"{name:5} {part.index.min():%Y-%m-%d} -> {part.index.max():%Y-%m-%d}  rows={len(part):,}  rain={part['y'].mean():.3f}  months={months}")
        if months < 12:
            print(f"      WARNING: {name} covers < 12 months, so it misses part of the wet/dry cycle.")
    if min(len(tr), len(va), len(te)) < 500 or min(tr.y.sum(), va.y.sum(), te.y.sum()) < 20:
        sys.exit("A split has too few rows or rain events. Download more history or adjust --train-end/--val-end.")

    # ----- one logistic regression per input set
    fits = {v: fit_logistic(tr, va, cols) for v, cols in variants.items()}
    print("\nvariants (validation Brier, lower is better):")
    for v, fit in fits.items():
        print(f"  {VARIANT_NAMES[v]:45s} features={len(fit['cols']):2d}  C={fit['C']:<5}  val Brier={fit['val_brier']:.5f}")
    chosen = a.variant if a.variant != "auto" else min(fits, key=lambda v: fits[v]["val_brier"])
    why = " (lowest validation Brier)" if a.variant == "auto" else " (--variant)"
    if a.variant == "auto" and chosen in ("motion", "phase"):
        # An extra satellite product must beat satellite without it by the same clear margin.
        gain = 1 - fits[chosen]["val_brier"] / fits["satellite"]["val_brier"]
        if gain < SAT_MIN_GAIN:
            print(f"{VARIANT_NAMES[chosen]} improves validation Brier by only {gain:.2%} over satellite alone "
                  f"(< {SAT_MIN_GAIN:.1%} needed)")
            chosen = "satellite"
        else:
            why = f" ({VARIANT_NAMES[chosen]} improves validation Brier by {gain:.2%} over satellite alone)"
    if a.variant == "auto" and chosen == "satellite":
        # Extra inputs always fit a little better by luck (random numbers won by 0.1% in a test),
        # so satellite has to EARN its place: a clear gain on validation, or the app keeps the simpler model.
        other = min((v for v in fits if v not in SAT_VARIANTS), key=lambda v: fits[v]["val_brier"])
        gain = 1 - fits["satellite"]["val_brier"] / fits[other]["val_brier"]
        if gain < SAT_MIN_GAIN:
            print(f"satellite improves validation Brier by only {gain:.2%} (< {SAT_MIN_GAIN:.1%} needed): not exported")
            chosen, why = other, f" (satellite gain {gain:.2%} too small)"
        else:
            why = f" (satellite improves validation Brier by {gain:.2%})"
    if "satellite" in fits and chosen not in SAT_VARIANTS and a.variant == "auto":
        # Every variant above was fitted on the satellite period only. Without satellite, the app's model
        # must learn from the FULL history again, so keep the comparison and train once more without it.
        REPORTS.mkdir(exist_ok=True)
        (REPORTS / f"satellite_comparison{sfx}.json").write_text(json.dumps({
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"), "kept": False, "reason": why.strip(" ()"),
            "min_gain": SAT_MIN_GAIN, "period": [f"{df.index.min():%Y-%m-%d}", f"{df.index.max():%Y-%m-%d}"],
            "val_brier": {VARIANT_NAMES[v]: round(f["val_brier"], 5) for v, f in fits.items()}}, indent=2))
        print("\nSatellite not kept (comparison saved to reports/satellite_comparison.json). "
              "Training again on the full history without it, so the exported model loses nothing:\n", flush=True)
        sys.argv.append("--no-satellite")  # same process, so the GUI's Stop ends it too
        return main()
    fit = fits[chosen]
    cols = fit["cols"]
    print(f"exported: {VARIANT_NAMES[chosen]}{why}")
    print(f"features ({len(cols)}): {cols}")
    export, predict_exp, tree_fit = choose_export(fit, tr, va, "model type", a.kind)

    p_val = predict_exp(va)
    alert = choose_threshold(va.y.to_numpy(), p_val) if a.alert == "auto" else float(a.alert)
    alert_rule = "best F2 score on the validation period" if a.alert == "auto" else "set by hand (--alert)"
    print(f"alert threshold: {alert:.2f} ({alert_rule})")

    p_exp = predict_exp(te)
    p_lr = fit["predict"](te)
    p_hgb = tree_fit["model"].predict_proba(te[cols].to_numpy())[:, 1]

    clim = tr.groupby([tr.index.month, tr.index.hour])["y"].mean()
    p_clim = np.array([clim.get((ts.month, ts.hour), tr.y.mean()) for ts in te.index])

    yt = te["y"].to_numpy()
    # Rain starts: rain at t+horizon while the latest airport report (or the last 15 min) was dry.
    dry_now = (obs_feats["obs_rain"].reindex(te.index) == 0) if obs_feats is not None else (base.loc[te.index, "persistence"] == 0)
    starts = (yt == 1) & dry_now.to_numpy()
    results = {
        "exported model": metrics(yt, p_exp, alert, starts),
        "logistic regression (uncalibrated)": metrics(yt, p_lr, alert, starts),
        "gradient boosting (uncalibrated)": metrics(yt, p_hgb, alert, starts),
    }
    for v, other in fits.items():
        if v != chosen:
            results[f"variant: {VARIANT_NAMES[v]}"] = metrics(yt, other["predict"](te), alert, starts)
    if a.sequence:
        from sequence_model import compare_sequence
        print("\nsequence experiment (nothing is exported, model files stay as they are):", flush=True)
        compare_sequence(allf, cols, tr, va, te, fit, alert, starts, metrics, choose_threshold,
                         REPORTS / f"sequence_comparison{sfx}.json")
        return
    baseline_keys = ["climatology (month x hour)", "persistence (rain in last 15 min)"]
    results["climatology (month x hour)"] = metrics(yt, p_clim, alert, starts)
    results["persistence (rain in last 15 min)"] = metrics(yt, base.loc[te.index, "persistence"].to_numpy(), 0.5, starts)
    if "airport_latest" in base:
        results["persistence (latest airport report)"] = metrics(yt, base.loc[te.index, "airport_latest"].to_numpy(), 0.5, starts)
        baseline_keys.append("persistence (latest airport report)")
    if "raw_provider" in base:
        ok = base.loc[te.index, "raw_provider"].notna().to_numpy()
        results["raw Open-Meteo probability"] = metrics(yt[ok], base.loc[te.index, "raw_provider"].to_numpy()[ok], alert, starts[ok])
        baseline_keys.append("raw Open-Meteo probability")

    compared = {"y": yt, "rain_start": starts.astype(int), "this_run": p_exp}
    if "raw_provider" in base:
        compared["open_meteo"] = base.loc[te.index, "raw_provider"].to_numpy()
    for path in a.compare:
        prev = json.loads(Path(path).read_text())
        if not set(prev["features"]) <= set(te.columns):
            print(f"--compare {path}: some of its inputs are not in this run, skipped")
            continue
        p_prev = np.array([model_probability(prev, r) for r in te[prev["features"]].to_dict("records")])
        results[f"compare: {Path(path).parent.name}/{Path(path).name}"] = metrics(
            yt, p_prev, float(prev.get("alert_threshold", alert)), starts)
        compared[f"{Path(path).parent.name}/{Path(path).name}"] = p_prev
    if a.compare:  # every test step's chance per model, for benchmark_chart.py
        pd.DataFrame(compared, index=te.index).to_csv(REPORTS / f"compare_predictions{sfx}.csv")
    table = pd.DataFrame(results).T[["n", "rain_rate", "brier", "roc_auc", "precision", "recall", "start_recall",
                                     "false_alarm_ratio", "false_positive_rate"]]
    print(f"\nTEST period results (alert threshold {alert:.2f}; start_recall = share of the {int(starts.sum())} "
          f"rain starts caught):\n{table.to_string()}\n")
    cal = calibration(yt, p_exp)
    print(f"calibration of the exported model ({export['kind']}{', calibrated' if export.get('calibration') else ''}, test):\n"
          + pd.DataFrame(cal).to_string(index=False))

    recommended = bool(results["exported model"]["brier"] < min(results[k]["brier"] for k in baseline_keys))
    print("\nVERDICT:", "model beats every baseline on Brier -> recommended" if recommended
          else "model does NOT beat all baselines -> keep the raw Open-Meteo probability (report this honestly)")

    # Variants are compared as logistic regressions, so the chosen one's row is its logistic score.
    res_of = lambda v: results["logistic regression (uncalibrated)" if v == chosen else f"variant: {VARIANT_NAMES[v]}"]
    variant_rows = [{"variant": v, "name": VARIANT_NAMES[v], "features": len(f["cols"]), "C": f["C"],
                     "val_brier": round(f["val_brier"], 5),
                     "test_brier": res_of(v)["brier"], "test_auc": res_of(v)["roc_auc"],
                     "test_start_recall": res_of(v)["start_recall"],
                     "exported": v == chosen} for v, f in fits.items()]

    # ----- outputs
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / f"metrics{sfx}.json").write_text(json.dumps({"label": label_name, "alert_threshold": alert, "alert_rule": alert_rule,
                                                      "variant": chosen, "variants": variant_rows,
                                                      "results": results, "calibration": cal}, indent=2))
    table.to_csv(REPORTS / f"results{sfx}.csv")
    try:
        import matplotlib; matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        c = pd.DataFrame(cal)
        plt.figure(figsize=(4.5, 4.5)); plt.plot([0, 1], [0, 1], "--", c="grey")
        plt.plot(c.mean_pred, c.observed, "o-"); plt.xlabel("predicted probability"); plt.ylabel("observed rain rate")
        plt.title("Calibration (test period)"); plt.tight_layout(); plt.savefig(REPORTS / f"calibration{sfx}.png", dpi=150)
    except Exception as exc:  # plotting is optional
        print("(no calibration plot:", exc, ")")

    uses_obs = any(c in OBS_FEATURES for c in cols)
    uses_mm = any(c in MM_FEATURES for c in cols)
    uses_sat = any(c in SAT_FEATURES for c in cols)
    fallback = None
    if uses_sat:
        # The app scores this when no satellite scan is recent enough (outage, slow download).
        fb_v = min((v for v in fits if v not in SAT_VARIANTS), key=lambda v: fits[v]["val_brier"])
        fb_export, fb_predict, _ = choose_export(fits[fb_v], tr, va, "fallback model type", a.kind)
        fb_alert = choose_threshold(va.y.to_numpy(), fb_predict(va)) if a.alert == "auto" else float(a.alert)
        fallback = {**fb_export, "variant": fb_v, "alert_threshold": fb_alert,
                    "test_metrics": metrics(yt, fb_predict(te), fb_alert, starts)}
        print(f"fallback without satellite: {VARIANT_NAMES[fb_v]} (alert {fb_alert:.2f})")
    model = {
        "version": 3, "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "horizon_minutes": a.horizon, "label_within": bool(a.within), "label_source": label_name, "label_threshold_mm": a.threshold_mm,
        "alert_threshold": alert, "alert_rule": alert_rule, "recommended": recommended,
        "variant": chosen, **export,
        "importance": importance(predict_exp, va, cols),
        "periods": {n: [f"{p.index.min():%Y-%m-%d}", f"{p.index.max():%Y-%m-%d}"] for n, p in (("train", tr), ("val", va), ("test", te))},
        "test_metrics": results["exported model"],
        "baselines_brier": {k: results[k]["brier"] for k in baseline_keys},
        "variants": variant_rows,
        "attribution": "Weather data by Open-Meteo.com",
    }
    if uses_obs:
        model["observation"] = {"station": a.station, "lag_minutes": OBS_LAG_MIN, "max_age_minutes": OBS_MAX_AGE_MIN,
                                "fresh_minutes": OBS_FRESH_MIN, "recent_minutes": OBS_RECENT_MIN}
        model["attribution"] += "; airport reports: NOAA Aviation Weather Center / Iowa Environmental Mesonet"
    if uses_mm or (fallback and any(c in MM_FEATURES for c in fallback["features"])):
        model["multi_model"] = {"models": MM_MODELS, "variables": MM_VARS, "min_models": MM_MIN_MODELS, "wet_mm": MM_WET_MM}
    if uses_sat:
        model["satellite"] = {"band": SAT_BAND, "water_vapour_band": SAT_WV_BAND, "cold_c": SAT_COLD_C, "lag_minutes": SAT_LAG_MIN,
                              "max_age_minutes": SAT_MAX_AGE_MIN, "cooling_minutes": [10, SAT_COOLING_MIN],
                              "steps_with_satellite": sat_rows, "cloud_motion": any(c in MOTION_FEATURES for c in cols),
                              "cloud_phase": any(c in CLOUD_FEATURES for c in cols)}
        model["fallback"] = fallback
        model["attribution"] += "; " + SAT_ATTRIBUTION
    model_json.write_text(json.dumps(model, indent=2))
    print(f"\nwrote {model_json}")

    # ----- parity cases so PHP can prove it computes the same numbers
    picks = list(te.index[::max(1, len(te) // 4)][:4])
    if uses_obs:  # make sure the airport path is exercised with rain, storm and stale reports
        for flag in ("obs_rain", "obs_lightning", "obs_rain_2h"):
            hit = te.index[(te[flag] > 0).to_numpy()] if flag in te else []
            if len(hit):
                picks.append(hit[len(hit) // 2])
        stale = te.index[(te["obs_age_min"] >= OBS_MAX_AGE_MIN).to_numpy()]
        if len(stale):
            picks.append(stale[0])
    if uses_mm:
        wet = te.index[(te["mm_wet_share"] >= 0.5).to_numpy()]
        if len(wet):
            picks.append(wet[len(wet) // 2])
    if uses_sat:
        cold = te.index[(te["sat_cold_30km"] >= 0.25).to_numpy()]
        if len(cold):
            picks.append(cold[len(cold) // 2])
    cases = []
    clean = lambda d: {k: [None if pd.isna(v) else (v if k == "time" else float(v)) for v in d[k]] for k in d}
    for ts in dict.fromkeys(picks):
        mw = m15.asfreq("15min").loc[ts - 11 * STEP: ts]
        base_h = ts.floor("h")
        hw = hourly.asfreq("1h").loc[base_h - pd.Timedelta(hours=3): base_h + pd.Timedelta(hours=1)]
        mdict = {"time": [t.strftime("%Y-%m-%dT%H:%M") for t in mw.index]} | {c: mw[c].tolist() for c in mw.columns}
        hdict = {"time": [t.strftime("%Y-%m-%dT%H:%M") for t in hw.index]} | {c: hw[c].tolist() for c in hw.columns}
        case = {"now": ts.strftime("%Y-%m-%dT%H:%M"), "minutely_15": clean(mdict), "hourly": clean(hdict)}
        if uses_obs:
            # Reports from well before the window up to an hour AFTER now: the future ones must be ignored.
            win = raw_reports.loc[ts - pd.Timedelta(minutes=OBS_MAX_AGE_MIN + 120): ts + pd.Timedelta(hours=1)]
            case["metars"] = [{"time": t.strftime("%Y-%m-%dT%H:%M"), "raw": r} for t, r in win.items()]
        if uses_mm:
            mw2 = mm.asfreq("1h").loc[base_h - pd.Timedelta(hours=1): base_h + pd.Timedelta(hours=2)]
            case["multi_model"] = clean({"time": [t.strftime("%Y-%m-%dT%H:%M") for t in mw2.index]}
                                        | {c: mw2[c].tolist() for c in mw2.columns})
        values = {c: float(te.loc[ts, c]) for c in te.columns if c != "y"}
        if uses_sat:
            # The app gets these from `python satellite.py now`; PHP only passes them on.
            case["satellite_features"] = {c: values[c] for c in SAT_FEATURES + MOTION_FEATURES + CLOUD_FEATURES if c in values}
            case["expected_fallback_probability"] = model_probability(fallback, values)
        case["expected_features"] = {c: values[c] for c in cols}
        case["expected_probability"] = model_probability(model, values)
        # The exported JSON must give exactly what training scored.
        assert abs(case["expected_probability"] - float(predict_exp(te.loc[[ts]])[0])) < 1e-9, "export does not match training"
        cases.append(case)
    parity_json.write_text(json.dumps({"timezone": TZ, "cases": cases}, indent=1))
    print(f"wrote {parity_json} ({len(cases)} cases for the PHP parity test)")


if __name__ == "__main__":
    main()
