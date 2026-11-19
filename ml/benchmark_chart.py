"""The README benchmark charts (light and dark), with every model scored on the same unseen steps.

Rain: reads reports/compare_predictions.csv, written by
    python train.py --compare reports/before-satellite/model.json reports/before-satellite-v2/model.json \
        reports/before-cloud-phase/model.json
and keeps Jul 29 - Oct 30 2026: the Nov 13 model trained up to Jul 29, so only those steps are unseen by
every model. Each method may warn on at most 5% of dry steps (its own threshold for that); the chart counts
the rain starts (dry, then rain) it warned about.
Heat: the current model and Open-Meteo from reports/heat_metrics.json; the two older models as measured
in their own runs (HEAT_REPORT.md).
Writes reports/benchmarks/{rain,heat}_benchmark_{light,dark}.png and benchmarks.json.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss, roc_auc_score

REPORTS = Path(__file__).resolve().parent / "reports"
OUT = REPORTS / "benchmarks"
FIRST_UNSEEN = "2026-07-29"
MAX_DRY_WARNED = 0.05

RAIN_METHODS = [  # (column in compare_predictions.csv, label)
    ("open_meteo", "Open-Meteo's own\nrain chance"),
    ("before-satellite/model.json", "Original model\n(Nov 7)"),
    ("before-satellite-v2/model.json", "First satellite\nmodel (Nov 13)"),
    ("before-cloud-phase/model.json", "+ water vapour\n(Nov 14)"),
    ("this_run", "+ cloud phase\n(Nov 19, current)"),
]
# Older heat models, as measured on the same test hours in their own runs (README benchmark table).
HEAT_HISTORY = {"First model (Nov 7, ERA5-trained)": [3.44, 3.48, 3.51],
                "Nov 14 model (airport thermometer)": [1.52, 1.58, 1.62]}

THEMES = {  # the dataviz reference palette, light and dark steps
    "light": dict(bg="#fcfcfb", ink="#0b0b0b", ink2="#4d4d4a", grid="#e4e3df", old="#bab7b0",
                  blue="#2a78d6", orange="#eb6834", aqua="#1baf7a", yellow="#eda100"),
    "dark": dict(bg="#1a1a19", ink="#f0efec", ink2="#c3c2b7", grid="#33332f", old="#5e5d57",
                 blue="#3987e5", orange="#d95926", aqua="#199e70", yellow="#c98500"),
}


def warned_starts(p: np.ndarray, y: np.ndarray, start: np.ndarray) -> tuple[int, float]:
    """Rain starts warned when the method may warn on at most MAX_DRY_WARNED of dry steps."""
    dry = np.sort(p[y == 0])[::-1]
    k = int(np.floor(MAX_DRY_WARNED * len(dry)))
    # Warn above the (k+1)-th highest dry value: at most k dry steps warned (ties at that value stay quiet).
    thr = dry[k] if k < len(dry) else -np.inf
    warned = p > thr
    return int((warned & (start == 1)).sum()), float(warned[y == 0].mean())


def rain_scores() -> dict:
    df = pd.read_csv(REPORTS / "compare_predictions.csv", index_col=0, parse_dates=True)
    df = df[df.index >= FIRST_UNSEEN]
    y, start = df["y"].to_numpy(), df["rain_start"].to_numpy()
    rows = []
    for col, label in RAIN_METHODS:
        ok = df[col].notna().to_numpy()
        p = df[col].to_numpy()[ok]
        n, dry_warned = warned_starts(p, y[ok], start[ok])
        rows.append({"method": label.replace("\n", " "), "starts": n, "dry_warned": round(dry_warned, 4),
                     "auc": round(float(roc_auc_score(y[ok], p)), 3), "brier": round(float(brier_score_loss(y[ok], p)), 4)})
    return {"rain": rows, "rain_steps": int(len(df)), "rain_starts": int(start.sum()),
            "rain_period": [FIRST_UNSEEN, f"{df.index.max():%Y-%m-%d}"]}


def heat_scores() -> dict:
    hz = json.loads((REPORTS / "heat_metrics.json").read_text())["horizons"]
    pick = lambda name: [round(hz[h]["results"][name]["mae"], 2) for h in ("1", "2", "3")]
    return {"heat_mae": {**HEAT_HISTORY,
                         "Nov 18 model (+ airport heat index, current)": pick("model (forecast inputs = deployed)"),
                         "Open-Meteo forecast": pick("forecast HI at target hour")}}


def draw(data: dict) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    for mode, t in THEMES.items():
        plt.rcParams.update({"font.family": "DejaVu Sans", "text.color": t["ink"], "axes.labelcolor": t["ink2"],
                             "xtick.color": t["ink2"], "ytick.color": t["ink2"]})
        # Rain: one bar per method in time order; the current model in blue, history in grey.
        fig, ax = plt.subplots(figsize=(12, 6.3), dpi=100)
        fig.patch.set_facecolor(t["bg"]); ax.set_facecolor(t["bg"])
        rows = data["rain"]
        x = np.arange(len(rows))
        colors = [t["old"]] * (len(rows) - 1) + [t["blue"]]
        ax.bar(x, [r["starts"] for r in rows], width=0.55, color=colors, edgecolor=t["bg"], linewidth=2, zorder=3)
        for i, r in enumerate(rows):
            ax.text(i, r["starts"] + 0.6, str(r["starts"]), ha="center", va="bottom", fontsize=17, fontweight="bold")
        if rows[0]["starts"] == 0:
            ax.text(0, 3.2, "says 100% on too many\ndry moments: cannot\nwarn at 5%", ha="center", fontsize=11.5, color=t["ink2"])
        ax.set_xticks(x, [label for _, label in RAIN_METHODS], fontsize=13.5)
        ax.set_ylabel(f"rain starts warned (of {data['rain_starts']})", fontsize=14)
        ax.set_ylim(0, max(r["starts"] for r in rows) * 1.18)
        ax.tick_params(axis="y", labelsize=14, length=0); ax.tick_params(axis="x", length=0)
        ax.grid(axis="y", color=t["grid"], linewidth=1, zorder=0)
        for s in ("top", "right", "left"):
            ax.spines[s].set_visible(False)
        ax.spines["bottom"].set_color(t["grid"])
        fig.text(0.07, 0.94, "Rain starts warned 20 minutes ahead, at the same false-alarm rate", fontsize=19, fontweight="bold")
        fig.text(0.07, 0.885, f"Each method warns on at most 5% of dry moments. Jul 29 - Oct 30 2026, {data['rain_steps']:,} steps "
                              "unseen by every model. Higher is better.", fontsize=12.5, color=t["ink2"])
        fig.subplots_adjust(left=0.07, right=0.98, top=0.84, bottom=0.14)
        fig.savefig(OUT / f"rain_benchmark_{mode}.png", facecolor=t["bg"]); plt.close(fig)

        # Heat: the three models over time, and Open-Meteo, at each horizon.
        fig, ax = plt.subplots(figsize=(12, 6.3), dpi=100)
        fig.patch.set_facecolor(t["bg"]); ax.set_facecolor(t["bg"])
        series = list(data["heat_mae"].items())
        colors = [t["orange"], t["aqua"], t["blue"], t["yellow"]]
        w = 0.2
        for k, ((name, vals), c) in enumerate(zip(series, colors)):
            xs = np.arange(3) + (k - 1.5) * w
            ax.bar(xs, vals, width=w - 0.02, color=c, edgecolor=t["bg"], linewidth=2, label=name, zorder=3)
            for xv, v in zip(xs, vals):
                ax.text(xv, v + 0.06, f"{v:.2f}", ha="center", va="bottom", fontsize=11.5)
        ax.set_xticks(np.arange(3), ["+1 hour", "+2 hours", "+3 hours"], fontsize=14)
        ax.set_ylabel("average error (°C)", fontsize=14)
        ax.set_ylim(0, 4.2)
        ax.tick_params(axis="y", labelsize=14, length=0); ax.tick_params(axis="x", length=0)
        ax.grid(axis="y", color=t["grid"], linewidth=1, zorder=0)
        for s in ("top", "right", "left"):
            ax.spines[s].set_visible(False)
        ax.spines["bottom"].set_color(t["grid"])
        leg = ax.legend(loc="upper left", bbox_to_anchor=(0, 1.2), ncol=2, frameon=False, fontsize=12.5, handlelength=1.4)
        for txt in leg.get_texts():
            txt.set_color(t["ink2"])
        fig.text(0.06, 0.94, "Heat index forecast error, against the airport thermometer", fontsize=19, fontweight="bold")
        fig.text(0.06, 0.885, "Test year Nov 2025 - Oct 2026, hours with a recent airport report (Nov 7 model: its own test). Lower is better.", fontsize=12.5, color=t["ink2"])
        fig.subplots_adjust(left=0.06, right=0.98, top=0.72, bottom=0.09)
        fig.savefig(OUT / f"heat_benchmark_{mode}.png", facecolor=t["bg"]); plt.close(fig)


def main() -> None:
    data = rain_scores() | heat_scores()
    OUT.mkdir(exist_ok=True)
    (OUT / "benchmarks.json").write_text(json.dumps(data, indent=1))
    for r in data["rain"]:
        print(f"{r['method']:<40} starts {r['starts']:>3}  dry warned {r['dry_warned']:.3f}  AUC {r['auc']:.3f}  Brier {r['brier']:.4f}")
    draw(data)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
