"""Train and honestly evaluate the AR-Node heat-index forecaster (+1, +2, +3 hours).

    python download_heat.py --start 2016-01-01
    python download_metar.py --start 2022-01-01   # the airport thermometer (truth)
    python train_heat.py                     # default: learn from archived forecasts (what the app receives)
    python train_heat.py --train-on era5     # learn from ERA5 inputs instead (comparison only)
    python train_heat.py --labels era5       # the old truth (comparison only)

Question answered: "what will the heat index be at the campus point in 1, 2 and
3 hours?" (NWS heat index in deg C, PAGASA categories; see heat_common.py).

Truth ("observed"), default --labels airport: the heat index the Zamboanga airport (RPMZ)
reported at the target hour, from its temperature and dew point, computed exactly like the
app's live record (heat_common.airport_heat_index = Metar::heatIndex in PHP). A real
thermometer a few km from campus. Until Nov 2026 the truth was ERA5 reanalysis (a ~25 km
model cell): it smooths out hot afternoons (never above 36.6 deg C here, while the airport
reached 43 deg C), so a model trained on it read 2.7 deg C too cool against the airport.

Split by TIME (never randomly): the most recent 12 months are the TEST set,
scored once at the end and never used for tuning; the 12 months before them
are VALIDATION (ridge strength is chosen there); everything earlier is TRAIN.

Inputs: by default the model learns from the Historical Forecast API archive,
i.e. the same kind of numbers the live app gets from the forecast API. Learning
from ERA5 inputs instead looks better on ERA5 inputs but the forecast runs about
1.2 deg C warmer than ERA5 here, so that model inherits the bias when deployed
(run --train-on era5 to see it). The forecast archive only starts in 2022, so
the default model trains on ~2.8 years; ERA5 (2016-) is still used for labels
and the diurnal baseline.

The model is one ridge regression per horizon (coefficients in heat_model.json,
scored in plain PHP by app/Services/HeatModel.php). It is only "recommended"
if, at EVERY horizon, its test MAE with FORECAST inputs (what the app really
receives) beats every deployable baseline:
  persistence        heat index now (from the forecast inputs)
  diurnal average    mean heat index for that month and target hour in the training years
  forecast HI        heat index from Open-Meteo's own forecast temperature/humidity at the target hour
Otherwise the app should keep the simple forecast-HI fallback.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

from common import REPORTS, TZ
from common import METAR_CSV
from heat_common import (CATEGORIES, CATEGORY_KEYS, ERA5_CSV, FORECAST_CSV, GRID_FIXTURE, HEAT_MODE_C, HEAT_MODEL_JSON,
                         HEAT_PARITY_JSON, HEAT_VARS, airport_heat_index, airport_hourly, build_heat_features, category,
                         heat_index_c, heat_index_series, read_hourly, target)

HORIZONS = [1, 2, 3]
ALPHAS = [0.01, 0.1, 1.0, 10.0, 100.0]
METRICS_JSON = REPORTS / "heat_metrics.json"
DANGER = {"danger", "extreme_danger"}


def scores(y: np.ndarray, p: np.ndarray) -> dict:
    """MAE, RMSE, bias (deg C), category accuracy, confusion matrix and Danger+ recall."""
    ok = ~(np.isnan(y) | np.isnan(p))
    y, p = y[ok], p[ok]
    if len(y) == 0:
        return {"n": 0}
    err = p - y
    yc = [category(v) for v in y]
    pc = [category(v) for v in p]
    conf = {a: {b: 0 for b in CATEGORY_KEYS} for a in CATEGORY_KEYS}
    for a, b in zip(yc, pc):
        conf[a][b] += 1
    danger_true = sum(1 for a in yc if a in DANGER)
    danger_hit = sum(1 for a, b in zip(yc, pc) if a in DANGER and b in DANGER)
    hot, warned = y >= HEAT_MODE_C, p >= HEAT_MODE_C
    return {
        "n": int(len(y)),
        "mae": round(float(np.abs(err).mean()), 3),
        "rmse": round(float(np.sqrt((err ** 2).mean())), 3),
        "bias": round(float(err.mean()), 3),
        "category_accuracy": round(float(np.mean([a == b for a, b in zip(yc, pc)])), 4),
        "danger_or_above_cases": int(danger_true),
        "danger_or_above_recall": round(danger_hit / danger_true, 4) if danger_true else None,
        # Heat mode (exposed paths closed): of the hours at or above HEAT_MODE_C, the share predicted there too,
        # and how many predicted hours were below it.
        "heat_mode_hours": int(hot.sum()),
        "heat_mode_recall": round(float(warned[hot].mean()), 4) if hot.any() else None,
        "heat_mode_false": int((warned & ~hot).sum()),
        "confusion": conf,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-on", choices=["era5", "forecast"], default="forecast",
                    help="which history the model learns from (labels are always ERA5)")
    ap.add_argument("--labels", choices=["airport", "era5"], default="airport",
                    help="the truth: the airport thermometer (default) or ERA5 reanalysis (the old truth, comparison only)")
    ap.add_argument("--test-months", type=int, default=12)
    ap.add_argument("--val-months", type=int, default=12)
    a = ap.parse_args()

    # The labels must be the numbers the app's live record compares with (Metar::heatIndex in PHP).
    for raw, php in (("RPMZ 010200Z 07010KT 9999 FEW017 30/23 Q1011 RMK A2985", 34.1),
                     ("RPMZ 120700Z 22008KT 9999 FEW020CB 35/27 Q1008", 46.7), ("RPMZ 121800Z 00000KT 9999 M01/M05 Q1011", -3.1)):
        assert airport_heat_index(raw) == php, f"airport heat index differs from PHP for {raw}"

    if not ERA5_CSV.exists():
        sys.exit(f"Missing {ERA5_CSV}. Run download_heat.py first.")
    if a.labels == "airport" and not METAR_CSV.exists():
        sys.exit(f"Missing {METAR_CSV}. Run download_metar.py (or step 2 in the GUI) first, or use --labels era5.")
    era5 = read_hourly(ERA5_CSV)
    # Truth at every hour of the ERA5 calendar (a complete hourly index); the airport series is NaN before 2022.
    truth = airport_hourly(era5.index) if a.labels == "airport" else target(era5, 0)
    fc = read_hourly(FORECAST_CSV) if FORECAST_CSV.exists() else None
    if a.train_on == "forecast" and fc is None:
        sys.exit(f"Missing {FORECAST_CSV}. Run download_heat.py without --skip-forecast.")

    f_era5 = build_heat_features(era5)
    f_fc = build_heat_features(fc) if fc is not None else None
    cols = list(f_era5.columns)

    # ----- chronological split on the truth's calendar
    last = truth.dropna().index.max()
    test_start = (last - pd.DateOffset(months=a.test_months)).floor("D") + pd.Timedelta(days=1)
    val_start = test_start - pd.DateOffset(months=a.val_months)
    print(f"train-on: {a.train_on}   labels: {'airport thermometer (RPMZ)' if a.labels == 'airport' else 'ERA5 reanalysis'}"
          f"\nfeatures ({len(cols)}): {cols}")
    print(f"split: train < {val_start:%Y-%m-%d} <= val < {test_start:%Y-%m-%d} <= test <= {last:%Y-%m-%d}")

    src = f_era5 if a.train_on == "era5" else f_fc
    hi_now_fc = f_fc["heat_index"] if f_fc is not None else None
    fc_hi = heat_index_series(fc["temperature_2m"], fc["relative_humidity_2m"]) if fc is not None else None

    model = {"version": 1, "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
             "target": "NWS heat index (deg C) at t + hours_ahead, labels from "
                       + ("the RPMZ airport temperature/dew point" if a.labels == "airport" else "ERA5 temperature/humidity"),
             "labels": a.labels, "train_on": a.train_on, "features": cols, "horizons": HORIZONS, "per_horizon": {},
             "categories": [{"min_c": lo, "key": k, "label": lab} for lo, k, lab in CATEGORIES],
             "attribution": "Weather data by Open-Meteo.com; ERA5: Copernicus Climate Change Service"}
    report: dict = {"train_on": a.train_on, "labels": a.labels, "split": {}, "horizons": {}}
    split_rows = {}
    verdict_ok = True

    for h in HORIZONS:
        y = truth.shift(-h).rename("y")
        df = src.join(y, how="inner").dropna()
        idx = df.index
        tr, va = df[idx < val_start], df[(idx >= val_start) & (idx < test_start)]
        if min(len(tr), len(va)) < 2000:
            sys.exit(f"Too few rows for +{h} h (train {len(tr)}, val {len(va)}). Download more history.")
        scaler = StandardScaler().fit(tr[cols].to_numpy())
        best = None
        for alpha in ALPHAS:
            m = Ridge(alpha=alpha).fit(scaler.transform(tr[cols].to_numpy()), tr["y"])
            mae = float(np.abs(m.predict(scaler.transform(va[cols].to_numpy())) - va["y"]).mean())
            if best is None or mae < best[0]:
                best = (mae, alpha, m)
        val_mae, alpha, ridge = best
        # Refit on train + validation with the chosen strength (the test set stays untouched).
        trva = pd.concat([tr, va])
        scaler = StandardScaler().fit(trva[cols].to_numpy())
        ridge = Ridge(alpha=alpha).fit(scaler.transform(trva[cols].to_numpy()), trva["y"])

        # ----- TEST (scored once)
        te_era5 = f_era5.join(y, how="inner").dropna()
        te_era5 = te_era5[te_era5.index >= test_start]
        pred = lambda X: ridge.predict(scaler.transform(X))  # noqa: E731
        res = {"model (ERA5 inputs)": scores(te_era5["y"].to_numpy(), pred(te_era5[cols].to_numpy())),
               "persistence (ERA5 now)": scores(te_era5["y"].to_numpy(), te_era5["heat_index"].to_numpy())}
        clim = trva.assign(month=trva.index.month, th=(trva.index + pd.Timedelta(hours=h)).hour).groupby(["month", "th"])["y"].mean()
        diurnal = np.array([clim.get((t.month, (t + pd.Timedelta(hours=h)).hour), np.nan) for t in te_era5.index])
        res["diurnal average"] = scores(te_era5["y"].to_numpy(), diurnal)
        deploy_key = "model (ERA5 inputs)"
        if f_fc is not None:
            te_fc = f_fc[f_fc.index >= test_start].join(y, how="inner").dropna()
            res["model (forecast inputs = deployed)"] = scores(te_fc["y"].to_numpy(), pred(te_fc[cols].to_numpy()))
            res["persistence (forecast now)"] = scores(te_fc["y"].to_numpy(), hi_now_fc.reindex(te_fc.index).to_numpy())
            fh = fc_hi.shift(-h).reindex(te_fc.index).to_numpy()
            res["forecast HI at target hour"] = scores(te_fc["y"].to_numpy(), fh)
            diurnal_fc = np.array([clim.get((t.month, (t + pd.Timedelta(hours=h)).hour), np.nan) for t in te_fc.index])
            res["diurnal average"] = scores(te_fc["y"].to_numpy(), diurnal_fc)
            deploy_key = "model (forecast inputs = deployed)"
            baselines = ["persistence (forecast now)", "diurnal average", "forecast HI at target hour"]
        else:
            baselines = ["persistence (ERA5 now)", "diurnal average"]
        beat = all(res[deploy_key]["mae"] < res[b]["mae"] for b in baselines)
        verdict_ok = verdict_ok and beat
        report["horizons"][str(h)] = {"alpha": alpha, "val_mae": round(val_mae, 3), "deployed_key": deploy_key,
                                      "beats_baselines": beat, "results": res}
        model["per_horizon"][str(h)] = {"alpha": alpha, "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
                                        "coef": ridge.coef_.tolist(), "intercept": float(ridge.intercept_),
                                        "test_mae_deployed": res[deploy_key]["mae"],
                                        "baseline_mae": {b: res[b]["mae"] for b in baselines}}
        split_rows = {"train": [f"{tr.index.min():%Y-%m-%d}", f"{tr.index.max():%Y-%m-%d}", len(tr)],
                      "val": [f"{va.index.min():%Y-%m-%d}", f"{va.index.max():%Y-%m-%d}", len(va)],
                      "test": [f"{te_era5.index.min():%Y-%m-%d}", f"{te_era5.index.max():%Y-%m-%d}", len(te_era5)]}
        table = pd.DataFrame({k: {m_: v.get(m_) for m_ in ("n", "mae", "rmse", "bias", "category_accuracy",
                                                              "danger_or_above_recall", "heat_mode_recall", "heat_mode_false")}
                              for k, v in res.items()}).T
        print(f"\n+{h} h  (ridge alpha={alpha}, validation MAE {val_mae:.3f})  TEST "
              f"({res[deploy_key].get('heat_mode_hours', 0)} hours at or above {HEAT_MODE_C:.0f} C, "
              f"{res[deploy_key].get('danger_or_above_cases', 0)} in Danger or above):\n{table.to_string()}")
        print("  ->", "beats every deployable baseline" if beat else "does NOT beat every deployable baseline")

    report["split"] = split_rows
    model["periods"] = split_rows
    model["recommended"] = bool(verdict_ok)
    report["recommended"] = bool(verdict_ok)
    print("\nVERDICT:", "model beats every deployable baseline at every horizon -> recommended" if verdict_ok
          else "model does NOT beat every deployable baseline -> ship the forecast-HI baseline (report this honestly)")

    REPORTS.mkdir(exist_ok=True)
    METRICS_JSON.write_text(json.dumps(report, indent=2))
    HEAT_MODEL_JSON.write_text(json.dumps(model, indent=2))
    print(f"\nwrote {HEAT_MODEL_JSON}\nwrote {METRICS_JSON}")

    # ----- parity cases: raw hourly window -> features and predictions (PHP must match)
    cases = []
    te = f_fc if f_fc is not None else f_era5
    te = te[te.index >= test_start].dropna()
    raw = fc if f_fc is not None else era5
    for ts in te.index[:: max(1, len(te) // 6)][:6]:
        w = raw.loc[ts - pd.Timedelta(hours=3): ts]
        hourly = {"time": [t.strftime("%Y-%m-%dT%H:%M") for t in w.index]} | {
            v: [None if pd.isna(x) else float(x) for x in w[v]] for v in HEAT_VARS}
        x = te.loc[[ts], cols].to_numpy()
        preds = {}
        for h in HORIZONS:
            ph = model["per_horizon"][str(h)]
            z = (x[0] - np.array(ph["mean"])) / np.where(np.array(ph["scale"]) == 0, 1.0, np.array(ph["scale"]))
            preds[str(h)] = float(np.dot(z, ph["coef"]) + ph["intercept"])
        cases.append({"now": ts.strftime("%Y-%m-%dT%H:%M"), "hourly": hourly,
                      "expected_features": {c: float(te.loc[ts, c]) for c in cols}, "expected_heat_index": preds})
    HEAT_PARITY_JSON.write_text(json.dumps({"timezone": TZ, "cases": cases}, indent=1))
    print(f"wrote {HEAT_PARITY_JSON} ({len(cases)} cases for the PHP parity test)")

    # ----- formula fixture shared by PHPUnit and node:test (temperature x humidity grid)
    grid = [{"t_c": t, "rh": rh, "heat_index_c": round(heat_index_c(t, rh), 6), "category": category(heat_index_c(t, rh))}
            for t in (20.0, 25.0, 26.7, 28.0, 30.0, 31.5, 33.0, 35.0, 37.0, 40.0, 43.0)
            for rh in (5.0, 10.0, 30.0, 50.0, 65.0, 80.0, 90.0, 100.0)]
    GRID_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    GRID_FIXTURE.write_text(json.dumps({"source": "ml/heat_common.py heat_index_c()", "cases": grid}, indent=1))
    print(f"wrote {GRID_FIXTURE} ({len(grid)} formula cases)")


if __name__ == "__main__":
    main()
