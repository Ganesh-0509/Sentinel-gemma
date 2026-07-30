"""Feature engineering -- where the 'compound' intelligence actually lives.

The single-sensor baseline looks at one number. This module turns the raw
multivariate stream into rolling trends, rates-of-change, operational context and
**cross-signal interaction terms** (e.g. gas_trend x hot_work_permit). Those
interactions are how the model detects dangerous *combinations* that no single
sensor would flag -- and, crucially, they are computed only from OBSERVABLE
signals (never from `gas_true`).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from sentinel import config as C

# Model inputs: hazard physics + operational context. `gas_true` is deliberately
# absent (it defines the label -- feeding it in would be leakage).
#
# The shift/roster group is ALSO deliberately excluded. See scripts/ablation_shift.py:
# once shift changeover was modelled properly, those features became genuinely
# predictive of the label -- and that turned out to be the problem. They predict
# whether a HUMAN will rescue the situation, so the model learns "day shift, no
# changeover -> someone will probably catch this -> lower risk" and under-alerts.
# At a matched false-alarm rate that cost 17.8 points of detection. A safety alert
# must reflect the HAZARD, not the odds that somebody else fixes it.
FEATURE_COLUMNS = [
    "gas_now", "gas_mean", "gas_max", "gas_std", "gas_trend", "gas_roc",
    "pressure_now", "pressure_trend", "pressure_roc",
    "temp_now", "temp_trend",
    "vib_now", "vib_mean",
    "maintenance_active", "hot_work_permit", "confined_space_permit",
    "time_since_maint", "time_since_permit",
    # interaction terms (the compound signal)
    "gas_trend_x_hotwork", "pressure_trend_x_hotwork",
    "gas_now_x_maint", "gas_roc_x_maint", "pressure_trend_x_maint",
]

# Shift/roster-derived signals. NOT model inputs -- they are consumed by the
# decision layer (sentinel/decision/priority.py) as consequence/urgency
# multipliers for alert prioritisation and evacuation.
SHIFT_FEATURE_GROUP = [
    "night_shift", "workers_in_zone",
    "in_changeover", "mins_since_changeover", "gas_trend_x_changeover",
]

# Used only by the ablation study to reproduce the "with shift" arm.
ALL_FEATURE_COLUMNS = FEATURE_COLUMNS + SHIFT_FEATURE_GROUP


def _slope(window: np.ndarray) -> float:
    """Least-squares slope of a short series (per-minute)."""
    m = len(window)
    if m < 2:
        return 0.0
    x = np.arange(m)
    x = x - x.mean()
    denom = (x * x).sum()
    if denom == 0:
        return 0.0
    return float((x * (window - window.mean())).sum() / denom)


def _time_since(active: np.ndarray) -> np.ndarray:
    """Minutes since the current active-block started (0 when inactive)."""
    out = np.zeros(len(active), dtype=float)
    run = 0
    for i, a in enumerate(active):
        run = run + 1 if a else 0
        out[i] = run
    return out


def build_features(episode: pd.DataFrame) -> pd.DataFrame:
    """Compute the feature matrix for a single episode (one row per minute).

    Rows before a full look-back window exist but use whatever history is
    available. `incident_onset` / `episode_id` / `minute` are carried through for
    the evaluation harness.
    """
    ep = episode.reset_index(drop=True)
    n = len(ep)
    W = C.WINDOW_MINUTES
    lag = C.ROC_LAG_MINUTES

    gas = ep["gas_sensor"].to_numpy()
    pres = ep["pressure"].to_numpy()
    temp = ep["temperature"].to_numpy()
    vib = ep["vibration"].to_numpy()

    rows = []
    tsm = _time_since(ep["maintenance_active"].to_numpy())
    tsp = _time_since(ep["hot_work_permit"].to_numpy())

    for i in range(n):
        lo = max(0, i - W + 1)
        gw, pw, tw, vw = gas[lo:i + 1], pres[lo:i + 1], temp[lo:i + 1], vib[lo:i + 1]
        j = max(0, i - lag)

        maint = int(ep["maintenance_active"][i])
        hot = int(ep["hot_work_permit"][i])
        gas_trend = _slope(gw)
        gas_roc = float(gas[i] - gas[j])
        pres_trend = _slope(pw)

        rows.append({
            "episode_id": int(ep["episode_id"][i]),
            "scenario": ep["scenario"][i],
            "minute": int(ep["minute"][i]),
            "incident_onset": int(ep["incident_onset"][i]),
            # --- features ---
            "gas_now": float(gas[i]),
            "gas_mean": float(gw.mean()),
            "gas_max": float(gw.max()),
            "gas_std": float(gw.std()),
            "gas_trend": gas_trend,
            "gas_roc": gas_roc,
            "pressure_now": float(pres[i]),
            "pressure_trend": pres_trend,
            "pressure_roc": float(pres[i] - pres[j]),
            "temp_now": float(temp[i]),
            "temp_trend": _slope(tw),
            "vib_now": float(vib[i]),
            "vib_mean": float(vw.mean()),
            "maintenance_active": maint,
            "hot_work_permit": hot,
            "confined_space_permit": int(ep["confined_space_permit"][i]),
            "night_shift": int(ep["night_shift"][i]),
            "workers_in_zone": int(ep["workers_in_zone"][i]),
            "in_changeover": int(ep["in_changeover"][i]),
            "mins_since_changeover": float(ep["mins_since_changeover"][i]),
            "gas_trend_x_changeover": gas_trend * int(ep["in_changeover"][i]),
            "time_since_maint": float(tsm[i]),
            "time_since_permit": float(tsp[i]),
            "gas_trend_x_hotwork": gas_trend * hot,
            "pressure_trend_x_hotwork": pres_trend * hot,
            "gas_now_x_maint": float(gas[i]) * maint,
            "gas_roc_x_maint": gas_roc * maint,
            "pressure_trend_x_maint": pres_trend * maint,
        })

    return pd.DataFrame(rows)


def label_rows(features: pd.DataFrame, horizon: int = C.PRIMARY_HORIZON) -> pd.DataFrame:
    """Attach the forecasting label y = 1 if an incident occurs in (t, t+horizon].

    Rows at or after the incident onset are dropped (we forecast, we do not learn
    from the aftermath). Non-incident episodes keep all rows with y = 0.
    """
    out = []
    for _, ep in features.groupby("episode_id", sort=False):
        ep = ep.sort_values("minute").reset_index(drop=True)
        onset = int(ep["incident_onset"].iloc[0])
        if onset >= 0:
            ep = ep[ep["minute"] < onset].copy()
            ep["y"] = ((onset - ep["minute"]) <= horizon).astype(int)
        else:
            ep = ep.copy()
            ep["y"] = 0
        out.append(ep)
    return pd.concat(out, ignore_index=True) if out else features.assign(y=0)
