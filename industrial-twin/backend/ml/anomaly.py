"""Unsupervised anomaly detector -- the safety net for unknown-unknowns.

The supervised forecaster only knows the failure modes it was trained on. This
module is trained on NORMAL operation only (no incident labels) and flags any
sensor behaviour that departs from the learned normal envelope -- catching novel
patterns the forecaster never saw. That directly attacks the false-negative rate.

Two complementary, dependency-light detectors:
    * Isolation Forest  -- multivariate point anomalies (fast, robust).
    * PCA reconstruction -- flags when the *correlation structure* between signals
      breaks (e.g. pressure rises while the gas point-sensor stays flat), which is
      exactly the compound/hidden signature. (Stand-in for an LSTM-Autoencoder,
      which is an optional heavier upgrade.)
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

from sentinel import config as C
from sentinel.ml.features import FEATURE_COLUMNS


class AnomalyDetector:
    def __init__(self, n_components: int = 6, contamination: float = 0.02):
        self.features = list(FEATURE_COLUMNS)
        self.scaler = StandardScaler()
        self.iforest = IsolationForest(
            n_estimators=200, contamination=contamination,
            random_state=C.GLOBAL_SEED, n_jobs=-1,
        )
        self.pca = PCA(n_components=n_components, random_state=C.GLOBAL_SEED)
        self._if_ref = (0.0, 1.0)     # mean/std of IF score on normal
        self._pca_ref = (0.0, 1.0)    # mean/std of recon error on normal
        self.threshold = 3.0          # z-score alert level

    def fit(self, normal_features: pd.DataFrame):
        X = self.scaler.fit_transform(normal_features[self.features])
        self.iforest.fit(X)
        self.pca.fit(X)
        if_raw = -self.iforest.score_samples(X)          # higher = more anomalous
        recon = self._recon_error(X)
        # robust location/scale (median + IQR) so a few extreme normals don't
        # collapse the scale and produce meaningless 3-digit z-scores
        self._if_ref = self._robust_ref(if_raw)
        self._pca_ref = self._robust_ref(recon)
        return self

    @staticmethod
    def _robust_ref(v: np.ndarray) -> tuple[float, float]:
        med = float(np.median(v))
        iqr = float(np.percentile(v, 75) - np.percentile(v, 25))
        return med, (iqr / 1.349 if iqr > 0 else float(v.std()) or 1.0) + 1e-9

    def _recon_error(self, X: np.ndarray) -> np.ndarray:
        return ((X - self.pca.inverse_transform(self.pca.transform(X))) ** 2).mean(axis=1)

    SCORE_CAP = 25.0   # keep the score human-readable on a dashboard

    def score(self, features: pd.DataFrame) -> np.ndarray:
        """Combined anomaly score (~0 = normal, >= threshold = anomalous, capped)."""
        X = self.scaler.transform(features[self.features])
        if_z = (-self.iforest.score_samples(X) - self._if_ref[0]) / self._if_ref[1]
        pca_z = (self._recon_error(X) - self._pca_ref[0]) / self._pca_ref[1]
        return np.clip(np.maximum(if_z, pca_z), 0.0, self.SCORE_CAP)

    def is_anomaly(self, features: pd.DataFrame) -> np.ndarray:
        return self.score(features) >= self.threshold
