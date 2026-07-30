"""Alert history and the consequence layer.

Two things are covered here:

  * `prioritise()` -- that PPE and lead time land in the *consequence* layer and
    never leak into the hazard probability.
  * `PlantService`'s alert log -- that an alert which rises and clears between
    two polls still leaves a record. The live queue only ever describes the
    current plant minute, so without this the console has no memory.
"""
from __future__ import annotations

from sentinel.api.service import PlantService
from sentinel.decision.priority import AlertContext, prioritise


# ------------------------------------------------------------- consequence
def test_uncovered_heads_raise_queue_position_but_not_risk():
    base = prioritise(AlertContext(risk=0.5, workers_in_zone=3))
    ppe = prioritise(AlertContext(risk=0.5, workers_in_zone=3, uncovered_heads=2))
    assert ppe["score"] > base["score"]
    # The hazard probability itself is untouched -- that is the whole point of
    # keeping PPE out of the model.
    assert ppe["risk"] == base["risk"] == 0.5


def test_ppe_factor_saturates():
    """An advisory detector must nudge the queue, never dominate it."""
    many = prioritise(AlertContext(risk=0.5, uncovered_heads=100))
    assert many["ppe_factor"] <= 1.20


def test_uncovered_heads_are_named_in_the_drivers():
    pr = prioritise(AlertContext(risk=0.5, uncovered_heads=1))
    assert any("helmet" in d for d in pr["drivers"])


def test_unknown_lead_time_is_not_reported_as_zero_minutes():
    """`None` means no horizon model fired, not "it is happening now"."""
    pr = prioritise(AlertContext(risk=0.4, lead_time_min=None))
    assert not any("threshold" in d for d in pr["drivers"])

    zero = prioritise(AlertContext(risk=0.4, lead_time_min=0))
    assert not any("threshold" in d for d in zero["drivers"])

    real = prioritise(AlertContext(risk=0.4, lead_time_min=15))
    assert any("~15 min to threshold" in d for d in real["drivers"])


# ---------------------------------------------------------------- alert log
def _service_with(queue: list[dict]) -> PlantService:
    """A service that reports a fixed alert queue, so transitions are testable
    without standing up the models."""
    svc = PlantService()
    svc.ready = True
    svc.alerts = lambda: list(queue)          # type: ignore[method-assign]
    return svc


def _alert(zone_id="COB-B", priority="HIGH", risk=0.7):
    return {"alert_id": f"{zone_id}-0001", "zone_id": zone_id,
            "zone_name": zone_id, "priority": priority, "score": 1.0,
            "risk": risk, "lead_time_min": None, "drivers": []}


def test_a_new_alert_is_logged_as_raised():
    svc = _service_with([_alert()])
    svc._record_alert_transitions()
    log = svc.alert_log_entries()
    assert len(log) == 1
    assert log[0]["event"] == "RAISED"
    assert log[0]["zone_id"] == "COB-B"


def test_an_unchanged_alert_is_not_logged_again():
    """Only transitions. Re-logging the queue every minute would bury the
    handful of events an investigator actually cares about."""
    queue = [_alert()]
    svc = _service_with(queue)
    for _ in range(5):
        svc._record_alert_transitions()
    assert len(svc.alert_log) == 1


def test_priority_changes_are_logged_in_both_directions():
    queue = [_alert(priority="MEDIUM")]
    svc = _service_with(queue)
    svc._record_alert_transitions()

    queue[0] = _alert(priority="CRITICAL")
    svc._record_alert_transitions()
    queue[0] = _alert(priority="LOW")
    svc._record_alert_transitions()

    events = [e["event"] for e in svc.alert_log]
    assert events == ["RAISED", "ESCALATED", "DE-ESCALATED"]
    assert svc.alert_log[1]["note"] == "MEDIUM -> CRITICAL"


def test_an_alert_that_clears_unattended_still_leaves_a_record():
    """The reported symptom: alerts scrolled away and left nothing behind."""
    queue = [_alert()]
    svc = _service_with(queue)
    svc._record_alert_transitions()

    queue.clear()
    svc.minute = 6
    svc._record_alert_transitions()

    log = svc.alert_log_entries()
    assert [e["event"] for e in log] == ["CLEARED", "RAISED"]   # newest first
    assert "6 min open" in log[0]["note"]


def test_a_cleared_alert_can_be_raised_again():
    queue = [_alert()]
    svc = _service_with(queue)
    svc._record_alert_transitions()
    queue.clear()
    svc._record_alert_transitions()
    queue.append(_alert())
    svc._record_alert_transitions()
    assert [e["event"] for e in svc.alert_log] == ["RAISED", "CLEARED", "RAISED"]


def test_the_log_can_be_filtered_to_one_zone():
    queue = [_alert("COB-B"), _alert("BLF-2")]
    svc = _service_with(queue)
    svc._record_alert_transitions()
    assert len(svc.alert_log_entries()) == 2
    assert len(svc.alert_log_entries(zone_id="BLF-2")) == 1


def test_the_log_is_bounded():
    from sentinel.api import service as svc_mod

    queue = [_alert()]
    svc = _service_with(queue)
    for i in range(svc_mod.ALERT_LOG_MAX + 50):
        # Alternate priority so every pass is a genuine transition.
        queue[0] = _alert(priority="HIGH" if i % 2 else "MEDIUM")
        svc._record_alert_transitions()
    assert len(svc.alert_log) == svc_mod.ALERT_LOG_MAX
    # The oldest entries are the ones dropped, so sequence numbers keep rising.
    assert svc.alert_log[-1]["seq"] > svc.alert_log[0]["seq"]


def test_logging_never_raises_when_the_queue_fails():
    """A logging fault must not be able to stop the plant clock."""
    svc = PlantService()
    svc.ready = True

    def boom():
        raise RuntimeError("model gone")

    svc.alerts = boom                          # type: ignore[method-assign]
    svc._record_alert_transitions()            # must not propagate
    assert svc.alert_log == []
