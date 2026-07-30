"""Baseline-vs-compound scoreboard -- the slide that wins the hackathon.

Everything is measured at the *episode* level, the way a safety officer actually
experiences it: did we get warned before the incident, how early, and how much
noise did we tolerate to get there. This maps 1:1 onto the judges' evaluation
focus:

    metric 1  compound vs single-sensor      -> detection_rate (compound vs baseline)
    metric 2  prediction lead time            -> mean_lead_min
    metric 5  false-negative reduction        -> false_negative_rate (lower = lives saved)
    (bonus)   false-alarm / nuisance load     -> false_alarm_rate, nuisance_minutes
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from sentinel.ml.baseline import baseline_alarm_series
from sentinel.ml.features import build_features


def _first_true_minute(mask: np.ndarray, minutes: np.ndarray) -> int | None:
    return int(minutes[np.argmax(mask)]) if mask.any() else None


def evaluate_episode(episode_raw: pd.DataFrame, forecaster) -> dict:
    """Score one episode for both detectors."""
    ep = episode_raw.sort_values("minute").reset_index(drop=True)
    minutes = ep["minute"].to_numpy()
    onset = int(ep["incident_onset"].iloc[0])
    has_incident = onset >= 0

    # --- baseline (single sensor, fixed threshold) ---
    base_mask = baseline_alarm_series(ep)
    base_alarm_t = _first_true_minute(base_mask, minutes)

    # --- compound model ---
    feats = build_features(ep)
    proba = forecaster.predict_proba(feats)
    model_mask = proba >= forecaster.threshold
    model_alarm_t = _first_true_minute(model_mask, feats["minute"].to_numpy())
    model_peak = float(proba.max())

    def detected(alarm_t):
        return alarm_t is not None and (not has_incident or alarm_t < onset)

    base_det = has_incident and base_alarm_t is not None and base_alarm_t < onset
    model_det = has_incident and model_alarm_t is not None and model_alarm_t < onset

    return {
        "episode_id": int(ep["episode_id"].iloc[0]),
        "scenario": ep["scenario"].iloc[0],
        "has_incident": has_incident,
        # a leak that developed but was isolated in time = NEAR MISS, not a safe
        # zone. Alerting on it is correct behaviour, so it must not be scored as
        # a false alarm.
        "had_leak": int(ep["leak_active"].max()) if "leak_active" in ep else 0,
        "onset": onset,
        # baseline
        "base_alarm_t": base_alarm_t,
        "base_detected": base_det,
        "base_lead": (onset - base_alarm_t) if base_det else None,
        "base_false_alarm": (not has_incident) and (base_alarm_t is not None),
        "base_alarm_minutes": int(base_mask.sum()),
        # compound model
        "model_alarm_t": model_alarm_t,
        "model_detected": model_det,
        "model_lead": (onset - model_alarm_t) if model_det else None,
        "model_false_alarm": (not has_incident) and (model_alarm_t is not None),
        "model_alarm_minutes": int(model_mask.sum()),
        "model_peak_proba": model_peak,
    }


def episode_signals(forecaster, raw: pd.DataFrame) -> list[dict]:
    """Pre-compute per-episode model probabilities so thresholds can be swept."""
    out = []
    for _, ep in raw.groupby("episode_id", sort=False):
        ep = ep.sort_values("minute").reset_index(drop=True)
        feats = build_features(ep)
        out.append({
            "proba": forecaster.predict_proba(feats),
            "minutes": feats["minute"].to_numpy(),
            "onset": int(ep["incident_onset"].iloc[0]),
            "had_leak": int(ep["leak_active"].max()) if "leak_active" in ep else 0,
        })
    return out


def operating_curve(signals: list[dict], n: int = 80) -> pd.DataFrame:
    """Detection / false-alarm / lead-time trade-off across all thresholds.

    This is what makes the baseline comparison honest: a low fixed-threshold alarm
    buys lead time by alarming constantly, so the two methods must be compared at
    the SAME nuisance level, not at whatever operating point each happens to use.
    """
    rows = []
    for t in np.linspace(0.05, 0.995, n):
        det = fa = n_inc = n_safe = 0
        lead_sum = 0.0
        for e in signals:
            mask = e["proba"] >= t
            at = int(e["minutes"][np.argmax(mask)]) if mask.any() else None
            if e["onset"] >= 0:
                n_inc += 1
                if at is not None and at < e["onset"]:
                    det += 1
                    lead_sum += e["onset"] - at
            elif e["had_leak"] == 0:
                n_safe += 1
                if at is not None:
                    fa += 1
        rows.append({"threshold": t, "detection": det / max(n_inc, 1),
                     "false_alarm": fa / max(n_safe, 1),
                     "lead": lead_sum / max(det, 1)})
    return pd.DataFrame(rows)


def tune_threshold(valid_raw: pd.DataFrame, forecaster, fa_cap: float = 0.12) -> float:
    """Pick an episode-level operating point on validation data.

    Strategy: among thresholds whose false-alarm rate on SAFE episodes stays under
    `fa_cap`, take the one that maximises incident detection; break ties toward the
    lower threshold (earlier alerts = more lead time). This optimises what we
    actually present -- detection + lead -- while capping nuisance.
    """
    episodes = []
    for _, ep in valid_raw.groupby("episode_id", sort=False):
        ep = ep.sort_values("minute").reset_index(drop=True)
        feats = build_features(ep)
        episodes.append({
            "proba": forecaster.predict_proba(feats),
            "minutes": feats["minute"].to_numpy(),
            "onset": int(ep["incident_onset"].iloc[0]),
            "had_leak": int(ep["leak_active"].max()) if "leak_active" in ep else 0,
        })

    grid = np.round(np.linspace(0.20, 0.95, 16), 3)
    best_t, best_key = None, (-1.0, -1.0)
    fallback_t, fallback_fa = 0.95, 1.1
    for t in grid:
        det = fa = n_inc = n_safe = 0
        lead_sum = 0.0
        for e in episodes:
            mask = e["proba"] >= t
            alarm_t = int(e["minutes"][np.argmax(mask)]) if mask.any() else None
            if e["onset"] >= 0:
                n_inc += 1
                if alarm_t is not None and alarm_t < e["onset"]:
                    det += 1
                    lead_sum += e["onset"] - alarm_t
            elif e["had_leak"] == 0:
                # only genuinely SAFE zones can generate a false alarm;
                # near-miss episodes are excluded (alerting there is correct)
                n_safe += 1
                if alarm_t is not None:
                    fa += 1
        det_rate = det / max(n_inc, 1)
        fa_rate = fa / max(n_safe, 1)
        mean_lead = lead_sum / max(det, 1)
        if fa_rate < fallback_fa:
            fallback_fa, fallback_t = fa_rate, float(t)
        if fa_rate <= fa_cap:
            key = (det_rate, mean_lead)
            if key > best_key:
                best_key, best_t = key, float(t)

    if best_t is None:
        # no operating point met the cap -- take the lowest-false-alarm option
        # and make the compromise visible rather than silently defaulting.
        print(f"   [tune] no threshold met fa_cap={fa_cap:.2f}; "
              f"falling back to t={fallback_t:.2f} (fa={fallback_fa:.1%})")
        best_t = fallback_t
    forecaster.threshold = best_t
    return best_t


def aggregate(results: list[dict]) -> dict:
    df = pd.DataFrame(results)
    inc = df[df["has_incident"]]
    # split non-incident episodes: genuinely safe vs near-miss (leak isolated in time)
    noinc = df[(~df["has_incident"]) & (df.get("had_leak", 0) == 0)]
    nearmiss = df[(~df["has_incident"]) & (df.get("had_leak", 0) == 1)]

    def lead(col):
        vals = inc[col].dropna().to_numpy()
        return float(np.mean(vals)) if len(vals) else float("nan")

    # matched subset: incidents BOTH detectors caught (apples-to-apples lead time)
    both = inc[inc["base_detected"] & inc["model_detected"]]
    matched_base = float(both["base_lead"].mean()) if len(both) else float("nan")
    matched_model = float(both["model_lead"].mean()) if len(both) else float("nan")
    # the killer stat: incidents baseline missed but SentinelAI caught
    saved = inc[(~inc["base_detected"]) & inc["model_detected"]]

    return {
        "matched_incidents": int(len(both)),
        "matched_baseline_lead_min": matched_base,
        "matched_compound_lead_min": matched_model,
        "incidents_missed_by_baseline_caught_by_compound": int(len(saved)),
        "n_episodes": len(df),
        "n_incident_episodes": int(len(inc)),
        "n_safe_episodes": int(len(noinc)),
        "n_nearmiss_episodes": int(len(nearmiss)),
        # early warning on a developing hazard a human later isolated -- this is
        # desirable behaviour, reported separately from false alarms
        "baseline_nearmiss_warning_rate": float(nearmiss["base_alarm_t"].notna().mean()) if len(nearmiss) else float("nan"),
        "compound_nearmiss_warning_rate": float(nearmiss["model_alarm_t"].notna().mean()) if len(nearmiss) else float("nan"),
        # metric 1 -- detection rate on genuine incidents
        "baseline_detection_rate": float(inc["base_detected"].mean()) if len(inc) else float("nan"),
        "compound_detection_rate": float(inc["model_detected"].mean()) if len(inc) else float("nan"),
        # metric 5 -- false negatives (missed incidents) = the lives-at-stake metric
        "baseline_false_negative_rate": float(1 - inc["base_detected"].mean()) if len(inc) else float("nan"),
        "compound_false_negative_rate": float(1 - inc["model_detected"].mean()) if len(inc) else float("nan"),
        # metric 2 -- lead time before the incident threshold
        "baseline_mean_lead_min": lead("base_lead"),
        "compound_mean_lead_min": lead("model_lead"),
        # bonus -- nuisance / false-alarm load on safe episodes
        "baseline_false_alarm_rate": float(noinc["base_false_alarm"].mean()) if len(noinc) else float("nan"),
        "compound_false_alarm_rate": float(noinc["model_false_alarm"].mean()) if len(noinc) else float("nan"),
        "baseline_nuisance_minutes": int(noinc["base_alarm_minutes"].sum()),
        "compound_nuisance_minutes": int(noinc["model_alarm_minutes"].sum()),
    }


def scoreboard_text(agg: dict) -> str:
    def pct(x):
        return "n/a" if x != x else f"{100 * x:5.1f}%"

    def mn(x):
        return "n/a" if x != x else f"{x:5.1f} min"

    lines = [
        "=" * 66,
        "  SENTINELAI SCOREBOARD  --  single-sensor baseline vs compound AI",
        "=" * 66,
        f"  episodes: {agg['n_episodes']}  "
        f"(incidents: {agg['n_incident_episodes']}, safe: {agg['n_safe_episodes']})",
        "-" * 66,
        f"  {'metric':<34}{'baseline':>14}{'SentinelAI':>14}",
        "-" * 66,
        f"  {'Incident detection rate':<34}{pct(agg['baseline_detection_rate']):>14}{pct(agg['compound_detection_rate']):>14}",
        f"  {'False-negative rate (missed)':<34}{pct(agg['baseline_false_negative_rate']):>14}{pct(agg['compound_false_negative_rate']):>14}",
        f"  {'Lead time (matched incidents)':<34}{mn(agg['matched_baseline_lead_min']):>14}{mn(agg['matched_compound_lead_min']):>14}",
        f"  {'False-alarm rate (safe zones)':<34}{pct(agg['baseline_false_alarm_rate']):>14}{pct(agg['compound_false_alarm_rate']):>14}",
        f"  {'Nuisance alarm-minutes':<34}{agg['baseline_nuisance_minutes']:>14}{agg['compound_nuisance_minutes']:>14}",
        "-" * 66,
        f"  >> Incidents the baseline MISSED that SentinelAI caught: "
        f"{agg['incidents_missed_by_baseline_caught_by_compound']}",
        f"     (each miss = a compound event a single sensor could not see)",
        "=" * 66,
    ]
    return "\n".join(lines)
