"""Regression test for the gas-monotonicity guarantee.

The forecaster once learned a scenario fingerprint rather than physical
causality: in the hidden-leak scenario the point sensor reads low while the zone
is genuinely dangerous, so "low reading + other cues" became evidence of danger
and *raising* the reading made the forecast collapse (0.67 -> 0.00).

An operator watching gas climb must never see risk fall. Two things enforce it:

  1. LightGBM monotone constraints on the gas level/trend features.
  2. The what-if applying a level shift across the whole feature window, so
     unconstrained features (notably gas_std) are not disturbed as a side
     effect -- otherwise the guarantee leaks even with the constraint in place.

Both are load-bearing, so both are tested.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from sentinel.ml.forecaster import MONOTONE_INCREASING, CompoundRiskForecaster, _monotone_vector
from sentinel.ml.features import FEATURE_COLUMNS

MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "forecaster.pkl"
GAS_STEPS = [0.0, 2.0, 4.0, 6.0, 8.0, 12.0, 20.0]

requires_model = pytest.mark.skipif(
    not MODEL_PATH.exists(), reason="run scripts/run_pipeline.py first"
)


def test_constraint_vector_matches_feature_order():
    vec = _monotone_vector(list(FEATURE_COLUMNS))
    assert len(vec) == len(FEATURE_COLUMNS)
    for col, flag in zip(FEATURE_COLUMNS, vec):
        assert flag == (1 if col in MONOTONE_INCREASING else 0)


def test_volatility_is_not_constrained():
    """gas_std is dispersion, not level; forcing a direction on it would be wrong."""
    assert "gas_std" not in MONOTONE_INCREASING


@requires_model
def test_raising_gas_never_lowers_risk():
    from sentinel.api.service import plant

    plant.startup()
    assert plant.ready, plant.error
    plant.set_minute(112)

    for zone in plant.zones:
        probs = [
            plant.simulate(zone.zone_id, gas_delta=g)["simulated_risk"] for g in GAS_STEPS
        ]
        for (g_lo, p_lo), (g_hi, p_hi) in zip(zip(GAS_STEPS, probs), zip(GAS_STEPS[1:], probs[1:])):
            assert p_hi >= p_lo - 1e-9, (
                f"{zone.zone_id}: gas +{g_lo} -> {p_lo:.4f} but +{g_hi} -> {p_hi:.4f}; "
                "more gas lowered risk"
            )


@requires_model
def test_lead_time_does_not_read_ground_truth():
    """Lead time must come from the horizon set, not the simulator's label.

    An earlier implementation returned `incident_onset - minute`, i.e. the
    answer key. Any lead time reported must be one of the trained horizons.
    """
    from sentinel import config as C
    from sentinel.api.service import plant

    plant.startup()
    assert plant.ready, plant.error

    seen = 0
    for minute in range(0, 240, 10):
        plant.set_minute(minute)
        for state in plant.zone_states():
            lead = state["lead_time_min"]
            if lead is not None:
                seen += 1
                assert lead in C.HORIZONS, f"lead {lead} is not a trained horizon {C.HORIZONS}"
    assert seen > 0, "no zone ever reported a lead time; test proves nothing"
