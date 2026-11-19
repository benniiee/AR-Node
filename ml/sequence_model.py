"""Time-series neural network for the rain model, as a COMPARISON only (python train.py --sequence; needs torch).

Question: does a model that reads the last 2 hours of inputs (8 steps of 15 minutes) as a sequence beat the
logistic regression that reads one moment? A GRU (recurrent network) reads the window; a linear term on the
current step is added to its output, so it starts from what the logistic regression already knows.

Same rows, same chronological train / validation / test split, same rain-start count as train.py. The window
uses only steps at or before t (inputs known at t). Nothing is exported and the app is not changed: the
result goes to reports/sequence_comparison.json. The app would only switch if the network clearly won
(at least 0.5% lower validation Brier, like any other new input), and would then need a scorer for it.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

WINDOW = 8          # steps of 15 minutes (2 hours) up to and including t
HIDDEN = 32
EPOCHS = 40
PATIENCE = 6        # epochs without a better validation Brier before stopping
SEEDS = (0, 1, 2)   # averaged: one seed can be lucky
MIN_GAIN = 0.005    # the same bar satellite had to clear


def windows(allf: pd.DataFrame, cols: list[str], rows: pd.DatetimeIndex, mean: np.ndarray, scale: np.ndarray) -> np.ndarray:
    """(rows, WINDOW, features): standardised inputs at t - 7 steps ... t; a missing step = the mean (0)."""
    grid = allf[cols].asfreq("15min")
    z = ((grid.to_numpy(dtype=float) - mean) / np.where(scale == 0, 1.0, scale))
    z = np.nan_to_num(z, nan=0.0)
    pos = grid.index.get_indexer(rows)
    out = np.zeros((len(rows), WINDOW, len(cols)), dtype=np.float32)
    for k in range(WINDOW):
        idx = pos - (WINDOW - 1 - k)
        ok = idx >= 0
        out[ok, k, :] = z[idx[ok]]
    return out


def compare_sequence(allf: pd.DataFrame, cols: list[str], tr: pd.DataFrame, va: pd.DataFrame, te: pd.DataFrame,
                     logistic: dict, alert: float, starts: np.ndarray, metrics, choose_threshold, out_path) -> dict:
    """Train the GRU (several seeds, early stopping on validation Brier) and compare it with the logistic fit."""
    import torch
    from torch import nn

    torch.set_num_threads(max(1, torch.get_num_threads()))
    mean, scale = logistic["scaler"].mean_, logistic["scaler"].scale_
    data = {name: (torch.from_numpy(windows(allf, cols, part.index, mean, scale)),
                   torch.from_numpy(part["y"].to_numpy(dtype=np.float32)))
            for name, part in (("train", tr), ("val", va), ("test", te))}

    class Net(nn.Module):
        def __init__(self, n: int):
            super().__init__()
            self.gru = nn.GRU(n, HIDDEN, batch_first=True)
            self.head = nn.Linear(HIDDEN, 1)
            self.wide = nn.Linear(n, 1)   # the current step, like the logistic regression

        def forward(self, x):
            _, h = self.gru(x)
            return (self.head(h[-1]) + self.wide(x[:, -1, :])).squeeze(-1)

    def brier(model, x, y) -> tuple[float, np.ndarray]:
        model.eval()
        with torch.no_grad():
            p = torch.sigmoid(model(x)).numpy()
        return float(np.mean((p - y.numpy()) ** 2)), p

    runs = []
    for seed in SEEDS:
        torch.manual_seed(seed)
        np.random.seed(seed)
        model = Net(len(cols))
        opt = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-4)
        loss_fn = nn.BCEWithLogitsLoss()
        x, y = data["train"]
        best, best_state, waited = None, None, 0
        for epoch in range(EPOCHS):
            model.train()
            order = torch.randperm(len(y))
            for i in range(0, len(y), 512):
                b = order[i:i + 512]
                opt.zero_grad()
                loss_fn(model(x[b]), y[b]).backward()
                opt.step()
            vb, _ = brier(model, *data["val"])
            if best is None or vb < best:
                best, best_state, waited = vb, {k: v.clone() for k, v in model.state_dict().items()}, 0
            else:
                waited += 1
                if waited >= PATIENCE:
                    break
        model.load_state_dict(best_state)
        runs.append(model)
        print(f"  GRU seed {seed}: validation Brier {best:.5f} (stopped after {epoch + 1} epochs)", flush=True)

    def mean_p(part: str) -> np.ndarray:
        return np.mean([brier(m, *data[part])[1] for m in runs], axis=0)

    yv, yt = va["y"].to_numpy(), te["y"].to_numpy()
    pv, pt = mean_p("val"), mean_p("test")
    val_brier = float(np.mean((pv - yv) ** 2))
    gru_alert = choose_threshold(yv, pv)
    gain = 1 - val_brier / logistic["val_brier"]
    result = {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_steps": WINDOW, "hidden": HIDDEN, "seeds": list(SEEDS), "features": len(cols),
        "rows": {"train": len(tr), "val": len(va), "test": len(te)},
        "val_brier": {"logistic regression": round(logistic["val_brier"], 5), "GRU (2-hour window)": round(val_brier, 5)},
        "validation_gain": round(gain, 4),
        "test": {"logistic regression": metrics(yt, logistic["predict"](te), alert, starts),
                 "GRU (2-hour window)": metrics(yt, pt, gru_alert, starts)},
        "kept": bool(gain >= MIN_GAIN),
        "rule": f"kept only with at least {MIN_GAIN:.1%} lower validation Brier than the logistic regression",
    }
    out_path.write_text(json.dumps(result, indent=2))
    print(f"\nGRU vs logistic regression (validation Brier {val_brier:.5f} vs {logistic['val_brier']:.5f}, gain {gain:.2%}):")
    for name, m in result["test"].items():
        print(f"  TEST {name:22s} Brier {m['brier']:.5f}  AUC {m['roc_auc']}  rain starts warned {m['start_recall']}"
              f"  dry moments warned {m['false_positive_rate']}")
    print("  ->", "the GRU clearly wins (a scorer for the app would be the next step)" if result["kept"]
          else "the GRU does not clearly win: the app keeps the logistic regression")
    print(f"wrote {out_path}")
    return result
