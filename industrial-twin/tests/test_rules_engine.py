"""Interlock tests.

These cover the safety contract: the deterministic layer decides, and the model
may only ever make an outcome stricter. If any of these fail, the guarantee the
whole system is sold on no longer holds.
"""
from __future__ import annotations

import pytest

from sentinel.rules.engine import (
    CONFINED_SPACE_MAX_LEL,
    GENERAL_MAX_LEL,
    HOT_WORK_MAX_LEL,
    O2_MAX_PCT,
    O2_MIN_PCT,
    TREND_IMMINENT_MIN,
    TREND_WATCH_MIN,
    PermitRequest,
    ZoneConditions,
    evaluate_interlocks,
    evaluate_permit,
    minutes_to_limit,
)

STRICTNESS = {"APPROVED": 0, "CONDITIONAL": 1, "REJECTED": 2}


def decide(permit_type="Hot Work", *, risk=None, **cond):
    return evaluate_permit(
        PermitRequest(permit_type, zone="COB-B"),
        ZoneConditions(**cond),
        compound_risk=risk,
    )


# ----------------------------------------------------------------- interlocks
def test_hot_work_rejected_at_gas_limit():
    assert decide(gas_lel=HOT_WORK_MAX_LEL).status == "REJECTED"


def test_hot_work_allowed_below_limit_in_calm_conditions():
    assert decide(gas_lel=HOT_WORK_MAX_LEL - 2.0).status == "APPROVED"


def test_confined_space_rejected_on_oxygen_deficiency():
    assert decide("Confined Space", gas_lel=0.0, o2_pct=O2_MIN_PCT - 0.1).status == "REJECTED"


def test_confined_space_rejected_on_oxygen_enrichment():
    """Enrichment is as disqualifying as deficiency -- it raises fire risk."""
    assert decide("Confined Space", gas_lel=0.0, o2_pct=O2_MAX_PCT + 0.1).status == "REJECTED"


def test_confined_space_rejected_at_gas_limit():
    assert decide("Confined Space", gas_lel=CONFINED_SPACE_MAX_LEL).status == "REJECTED"


def test_general_work_rejected_at_general_limit():
    assert decide("Cold Work", gas_lel=GENERAL_MAX_LEL).status == "REJECTED"


def test_cold_work_tolerates_gas_that_bars_hot_work():
    """No ignition source, so the hot-work limit must not apply to cold work."""
    assert decide("Cold Work", gas_lel=HOT_WORK_MAX_LEL + 1.0).status != "REJECTED"


# ------------------------------------------------------------ safety contract
@pytest.mark.parametrize("risk", [0.0, 0.25, 0.5, 0.75, 0.9, 1.0])
@pytest.mark.parametrize("gas", [0.0, 2.0, 4.0, 6.0, 12.0, 40.0])
def test_model_can_only_tighten_never_loosen(risk, gas):
    """The model must never move a decision toward permissive.

    This is the load-bearing property: sweep the model output across its whole
    range at each gas level and assert the verdict is never weaker than the
    deterministic one.
    """
    deterministic = decide(gas_lel=gas)
    with_model = decide(gas_lel=gas, risk=risk)
    assert STRICTNESS[with_model.status] >= STRICTNESS[deterministic.status]


def test_high_risk_cannot_rescue_a_rejected_permit():
    """Even a zero-risk model output cannot clear a hard gas rejection."""
    assert decide(gas_lel=HOT_WORK_MAX_LEL + 10, risk=0.0).status == "REJECTED"


def test_high_model_risk_escalates_an_otherwise_approved_permit():
    calm = dict(gas_lel=0.5)
    assert decide(**calm).status == "APPROVED"
    assert decide(**calm, risk=0.95).status == "REJECTED"


def test_moderate_model_risk_downgrades_to_conditional():
    assert decide(gas_lel=0.5, risk=0.6).status == "CONDITIONAL"


# ------------------------------------------------------- standing interlocks
def test_active_hot_work_above_limit_triggers_suspension():
    out = evaluate_interlocks(ZoneConditions(gas_lel=HOT_WORK_MAX_LEL + 1), hot_work_active=True)
    assert out and any("SUSPEND" in s.upper() for s in out)


def test_workers_present_above_general_limit_triggers_evacuation():
    out = evaluate_interlocks(
        ZoneConditions(gas_lel=GENERAL_MAX_LEL + 1, workers_in_zone=4), hot_work_active=False
    )
    assert out and any("EVACUAT" in s.upper() for s in out)


def test_calm_zone_raises_no_standing_interlocks():
    assert evaluate_interlocks(ZoneConditions(gas_lel=0.5, workers_in_zone=2), False) == []


# ------------------------------------------------------------------- outputs
def test_every_decision_carries_a_reason():
    for permit in ("Hot Work", "Confined Space", "Cold Work", "Electrical"):
        for gas in (0.0, 6.0, 20.0):
            d = decide(permit, gas_lel=gas)
            assert d.reasons, f"{permit} @ {gas} %LEL produced no reason"


def test_every_decision_shows_its_working():
    """An APPROVED permit must still be evidence that the interlocks ran."""
    for permit in ("Hot Work", "Confined Space", "Cold Work", "Electrical"):
        d = decide(permit, gas_lel=0.5)
        assert d.checks, f"{permit} produced no audit trail"
        assert any("%LEL" in c or "% LEL" in c for c in d.checks)


# ------------------------------------------------------ trend projection
def test_minutes_to_limit_is_none_when_not_rising():
    assert minutes_to_limit(1.0, 0.0, 5.0) is None
    assert minutes_to_limit(1.0, -0.5, 5.0) is None
    assert minutes_to_limit(6.0, 0.5, 5.0) is None      # already over


def test_minutes_to_limit_projects_the_crossing():
    assert minutes_to_limit(4.0, 0.5, 5.0) == pytest.approx(2.0)


def test_hot_work_rejected_when_gas_is_about_to_cross_the_limit():
    """The defect this closes: 4.2 %LEL rising 0.36/min was APPROVED outright.

    It is below the 5.0 limit, so a level-only check clears it -- but it crosses
    in about two minutes, which is inside the window the permit authorises.
    """
    d = decide(gas_lel=4.24, gas_trend=0.361)
    assert d.status == "REJECTED"
    assert any("projected" in r for r in d.reasons)


def test_slowly_rising_gas_is_conditional_not_rejected():
    # ~10 min to the limit: inside the watch window, outside the imminent one.
    d = decide(gas_lel=4.0, gas_trend=0.10)
    assert d.status == "CONDITIONAL"


def test_gas_far_from_the_limit_is_unaffected_by_a_rising_trend():
    eta = minutes_to_limit(1.0, 0.05, HOT_WORK_MAX_LEL)
    assert eta is not None and eta > TREND_WATCH_MIN
    assert decide(gas_lel=1.0, gas_trend=0.05).status == "APPROVED"


def test_falling_gas_near_the_limit_is_not_penalised():
    """Trend cuts both ways: approaching is the hazard, receding is not."""
    assert decide(gas_lel=4.5, gas_trend=-0.5).status == "APPROVED"


@pytest.mark.parametrize("trend", [0.0, 0.05, 0.2, 0.5, 2.0])
@pytest.mark.parametrize("gas", [0.0, 2.0, 4.0, 4.9, 6.0])
def test_trend_can_only_tighten_never_loosen(gas, trend):
    flat = decide(gas_lel=gas)
    rising = decide(gas_lel=gas, gas_trend=trend)
    assert STRICTNESS[rising.status] >= STRICTNESS[flat.status]


# --------------------------------------------------------------- oxygen
def test_confined_space_cannot_be_approved_without_an_oxygen_reading():
    """Not instrumented is not the same as normal.

    The API supplies no O2 channel, so the old 20.9% default meant every
    confined-space oxygen check passed on a measurement nobody took -- making a
    Confined Space permit indistinguishable from a Cold Work one.
    """
    d = decide("Confined Space", gas_lel=0.5)          # o2_pct defaults to None
    assert d.status == "CONDITIONAL"
    assert any("not instrumented" in r for r in d.reasons)
    assert any("NOT MEASURED" in c for c in d.checks)


def test_confined_space_with_a_good_oxygen_reading_is_approved():
    assert decide("Confined Space", gas_lel=0.5, o2_pct=20.9).status == "APPROVED"


def test_missing_oxygen_does_not_affect_other_permit_types():
    """Only confined-space entry turns on an O2 test."""
    for permit in ("Hot Work", "Cold Work", "Electrical"):
        assert decide(permit, gas_lel=0.5).status == "APPROVED"


# ------------------------------------------------------------------ PPE
def test_uncovered_heads_downgrade_a_permit_to_conditional():
    d = decide(gas_lel=0.5, uncovered_heads=2)
    assert d.status == "CONDITIONAL"
    assert any("helmet" in r for r in d.reasons)


def test_ppe_alone_can_never_reject_a_permit():
    """Advisory detection tightens; it does not stop work on its own."""
    assert decide(gas_lel=0.5, uncovered_heads=50).status == "CONDITIONAL"


def test_unverified_ppe_does_not_downgrade():
    """A detector whose helmet class never fires is not evidence of a violation."""
    d = decide(gas_lel=0.5, uncovered_heads=3, ppe_verified=False)
    assert d.status == "APPROVED"
    assert any("not verifiable" in c for c in d.checks)


def test_ppe_never_rescues_a_rejected_permit():
    clean = decide(gas_lel=HOT_WORK_MAX_LEL + 5, uncovered_heads=0)
    with_ppe = decide(gas_lel=HOT_WORK_MAX_LEL + 5, uncovered_heads=0, ppe_verified=True)
    assert clean.status == with_ppe.status == "REJECTED"


def test_imminent_window_is_stricter_than_the_watch_window():
    assert TREND_IMMINENT_MIN < TREND_WATCH_MIN
