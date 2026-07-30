"""Compound Risk Forecaster -- the star model.

A LightGBM classifier that predicts P(incident within the primary horizon) from
the engineered, observable features. Chosen over deep sequence models because the
data is tabular + limited + mixed-type: gradient-boosted trees train in seconds,
handle missing values, and -- most importantly for this project -- expose feature
attributions (native importances now; SHAP later) so every alert is explainable.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.metrics import (
    average_precision_score,
    f1_score,
    precision_recall_fscore_support,
    roc_auc_score,
)

from sentinel import config as C
from sentinel.ml.features import FEATURE_COLUMNS


# Features where more gas must never mean less risk.
#
# Without this the model is free to learn a scenario *fingerprint* rather than
# physical causality: in the hidden-leak scenario the point sensor reads low
# while the zone is genuinely dangerous, so "low reading + other cues" became
# evidence of danger and raising the reading made the forecast fall. That is
# indefensible in a safety system -- an operator watching gas climb must never
# see risk drop. A monotone constraint makes the direction a property of the
# model rather than something we hope the data teaches.
#
# Only gas magnitude/trend terms are constrained. Pressure and temperature are
# genuinely two-sided (a drop can indicate a leak), and gas_std is volatility,
# not level, so those are left free.
MONOTONE_INCREASING = {
    "gas_now", "gas_mean", "gas_max", "gas_trend", "gas_roc",
    "gas_trend_x_hotwork", "gas_now_x_maint", "gas_roc_x_maint",
}


def _monotone_vector(feature_columns: list[str]) -> list[int]:
    return [1 if c in MONOTONE_INCREASING else 0 for c in feature_columns]


class CompoundRiskForecaster:
    """Thin wrapper around LightGBM with save/load and threshold selection.

    `horizon` records the label window the instance was trained against, so a
    multi-horizon set can be persisted and reloaded without ambiguity.
    """

    def __init__(self, params: dict | None = None, horizon: int = C.PRIMARY_HORIZON):
        self.horizon = int(horizon)
        self.params = params or dict(
            n_estimators=300,
            learning_rate=0.05,
            num_leaves=31,
            max_depth=-1,
            subsample=0.9,
            colsample_bytree=0.9,
            reg_lambda=1.0,
            random_state=C.GLOBAL_SEED,
            n_jobs=-1,
            verbosity=-1,
        )
        self.feature_columns = list(FEATURE_COLUMNS)
        self.params.setdefault("monotone_constraints", _monotone_vector(self.feature_columns))
        self.params.setdefault("monotone_constraints_method", "advanced")
        self.model = LGBMClassifier(**self.params)
        self.threshold = C.MODEL_DECISION_THRESHOLD

    # ------------------------------------------------------------------ train
    def fit(self, train_df: pd.DataFrame, valid_df: pd.DataFrame | None = None):
        Xtr, ytr = train_df[self.feature_columns], train_df["y"]
        # class imbalance: incidents-within-horizon are the minority
        pos = max(int(ytr.sum()), 1)
        neg = int((ytr == 0).sum())
        self.model.set_params(scale_pos_weight=neg / pos)
        self.model.fit(Xtr, ytr)
        if valid_df is not None and len(valid_df):
            self.threshold = self._pick_threshold(valid_df)
        return self

    def _pick_threshold(self, valid_df: pd.DataFrame) -> float:
        """Choose the probability threshold that maximises row-level F1 on validation."""
        p = self.predict_proba(valid_df)
        y = valid_df["y"].to_numpy()
        best_t, best_f1 = 0.5, -1.0
        for t in np.linspace(0.05, 0.95, 19):
            f1 = f1_score(y, (p >= t).astype(int), zero_division=0)
            if f1 > best_f1:
                best_f1, best_t = f1, float(t)
        return best_t

    # --------------------------------------------------------------- predict
    def predict_proba(self, df: pd.DataFrame) -> np.ndarray:
        return self.model.predict_proba(df[self.feature_columns])[:, 1]

    # --------------------------------------------------------------- metrics
    def evaluate_rows(self, test_df: pd.DataFrame) -> dict:
        p = self.predict_proba(test_df)
        y = test_df["y"].to_numpy()
        yhat = (p >= self.threshold).astype(int)
        pr, rc, f1, _ = precision_recall_fscore_support(
            y, yhat, average="binary", zero_division=0
        )
        return {
            "threshold": self.threshold,
            "precision": float(pr),
            "recall": float(rc),
            "f1": float(f1),
            "roc_auc": float(roc_auc_score(y, p)) if len(set(y)) > 1 else float("nan"),
            "pr_auc": float(average_precision_score(y, p)) if len(set(y)) > 1 else float("nan"),
            "n_rows": int(len(y)),
            "positive_rate": float(y.mean()),
        }

    def feature_importance(self, top: int = 12) -> list[tuple[str, float]]:
        imp = self.model.feature_importances_
        pairs = sorted(zip(self.feature_columns, imp), key=lambda kv: kv[1], reverse=True)
        return [(k, float(v)) for k, v in pairs[:top]]

    # ------------------------------------------------------------ persistence
    def save(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        import joblib
        joblib.dump(
            {"model": self.model, "threshold": self.threshold,
             "feature_columns": self.feature_columns, "horizon": self.horizon}, path
        )
        meta = {"threshold": self.threshold, "horizon": self.horizon,
                "feature_columns": self.feature_columns, "params": self.params}
        path.with_suffix(".json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, path: str | Path) -> "CompoundRiskForecaster":
        import joblib
        blob = joblib.load(path)
        obj = cls(horizon=blob.get("horizon", C.PRIMARY_HORIZON))
        obj.model = blob["model"]
        obj.threshold = blob["threshold"]
        obj.feature_columns = blob["feature_columns"]
        return obj
