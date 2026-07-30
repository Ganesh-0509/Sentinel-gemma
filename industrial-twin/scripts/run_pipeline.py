"""End-to-end training + evaluation pipeline.

Produces the artefacts the API depends on:

    models/forecaster.pkl       primary forecaster (P(incident within 30 min))
    models/forecaster_15.pkl    short-horizon model
    models/forecaster_60.pkl    long-horizon model
    reports/scoreboard.json     baseline-vs-compound evidence

The horizon set exists so lead time can be *predicted* rather than read off the
label: the earliest horizon whose probability clears its own threshold is the
warning time. See `PlantService._lead_time`.

Run from the repository root:

    python scripts/run_pipeline.py --episodes 3000
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sentinel import config as C  # noqa: E402
from sentinel.evaluation.harness import (  # noqa: E402
    aggregate,
    evaluate_episode,
    scoreboard_text,
    tune_threshold,
)
from sentinel.ml.features import build_features, label_rows  # noqa: E402
from sentinel.ml.forecaster import CompoundRiskForecaster  # noqa: E402
from sentinel.sim.simulator import generate_dataset  # noqa: E402

MODEL_DIR = ROOT / "models"
REPORT_PATH = ROOT / "reports" / "scoreboard.json"


def split_episodes(raw: pd.DataFrame, seed: int) -> tuple[pd.DataFrame, ...]:
    """Split 60/20/20 by episode id, so no episode spans two sets."""
    ids = np.array(sorted(raw["episode_id"].unique()))
    rng = np.random.default_rng(seed)
    rng.shuffle(ids)
    n_train = int(len(ids) * 0.6)
    n_valid = int(len(ids) * 0.2)
    groups = (ids[:n_train], ids[n_train:n_train + n_valid], ids[n_train + n_valid:])
    return tuple(raw[raw["episode_id"].isin(g)].copy() for g in groups)


def featurise(raw: pd.DataFrame) -> pd.DataFrame:
    """Per-minute features for every episode (labels attached separately)."""
    frames = [
        build_features(ep.sort_values("minute").reset_index(drop=True))
        for _, ep in raw.groupby("episode_id", sort=False)
    ]
    return pd.concat(frames, ignore_index=True)


def train_for_horizon(train_feats, valid_feats, valid_raw, horizon, fa_cap):
    train_df = label_rows(train_feats, horizon=horizon)
    valid_df = label_rows(valid_feats, horizon=horizon)

    model = CompoundRiskForecaster(horizon=horizon).fit(train_df, valid_df)
    rows = model.evaluate_rows(valid_df)
    threshold = tune_threshold(valid_raw, model, fa_cap=fa_cap)

    path = MODEL_DIR / (
        "forecaster.pkl" if horizon == C.PRIMARY_HORIZON else f"forecaster_{horizon}.pkl"
    )
    model.save(path)
    print(f"      h={horizon:>2}min  PR-AUC={rows['pr_auc']:.3f}"
          f"  ROC-AUC={rows['roc_auc']:.3f}  threshold={threshold:.2f}"
          f"  -> {path.name}")
    return model


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--episodes", type=int, default=3000, help="episodes to simulate")
    ap.add_argument("--seed", type=int, default=C.GLOBAL_SEED)
    ap.add_argument("--fa-cap", type=float, default=0.12,
                    help="max false-alarm rate on safe episodes when tuning")
    args = ap.parse_args()

    print(f"[1/5] Simulating {args.episodes} episodes (seed={args.seed}) ...")
    raw = generate_dataset(args.episodes, seed=args.seed)
    train_raw, valid_raw, test_raw = split_episodes(raw, args.seed)
    print(f"      episodes  train={train_raw['episode_id'].nunique()}"
          f"  valid={valid_raw['episode_id'].nunique()}"
          f"  test={test_raw['episode_id'].nunique()}")

    print("[2/5] Engineering features ...")
    train_feats = featurise(train_raw)
    valid_feats = featurise(valid_raw)
    print(f"      rows  train={len(train_feats):,}  valid={len(valid_feats):,}")

    print(f"[3/5] Training horizon set {C.HORIZONS} (gas monotone-constrained) ...")
    models = {
        h: train_for_horizon(train_feats, valid_feats, valid_raw, h, args.fa_cap)
        for h in C.HORIZONS
    }
    primary = models[C.PRIMARY_HORIZON]
    print("      top features (primary): " + ", ".join(
        f"{k}({v:.0f})" for k, v in primary.feature_importance(5)))

    print("[4/5] Verifying gas monotonicity ...")
    ok = check_monotonicity(primary, valid_feats)
    print(f"      more gas never lowers risk: {'PASS' if ok else 'FAIL'}")

    print("[5/5] Scoring held-out test episodes ...")
    results = [
        evaluate_episode(ep, primary)
        for _, ep in test_raw.groupby("episode_id", sort=False)
    ]
    agg = aggregate(results)
    agg["gas_monotonicity_verified"] = bool(ok)
    agg["horizons"] = list(C.HORIZONS)

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(agg, indent=2))
    print(f"      saved {REPORT_PATH.relative_to(ROOT)}\n")
    print(scoreboard_text(agg))
    return 0


def check_monotonicity(model, feats: pd.DataFrame, n: int = 400) -> bool:
    """Sweep gas upward on real rows and assert the forecast never decreases.

    This is the property the constraint is meant to guarantee; asserting it here
    means a regression shows up at training time, not in front of an operator.
    """
    sample = feats.sample(min(n, len(feats)), random_state=C.GLOBAL_SEED)
    gas_cols = [c for c in ("gas_now", "gas_mean", "gas_max") if c in sample.columns]
    prev = model.predict_proba(sample)
    for bump in (1.0, 3.0, 6.0, 12.0):
        probe = sample.copy()
        for c in gas_cols:
            probe[c] = probe[c] + bump
        cur = model.predict_proba(probe)
        if (cur < prev - 1e-9).any():
            return False
        prev = cur
    return True


if __name__ == "__main__":
    raise SystemExit(main())
