"""The gate between a Gemma proposal and a real containment action.

These cases are not hypothetical. Every malformed plan below was produced by
`gemma3:latest` against a Zone-4 hot-work scenario, with decoding already
constrained to the proposal schema. Valid JSON, wrong content -- which is the
whole reason `authorise` exists.
"""
from __future__ import annotations

from sentinel.agents.tools import REGISTRY, execute_plan, proposal_schema, tool_catalogue


def _run(plan, *, escalated=True, permit_rejected=True):
    return execute_plan(plan, zone_id="Zone-4", permit_id="P-402",
                        escalated=escalated, permit_rejected=permit_rejected)


def _by_tool(receipts, name):
    return [r for r in receipts if r["tool"] == name]


# ------------------------------------------------------- argument correction
def test_invented_argument_names_are_mapped_not_passed_through():
    """The model offered `rate`/`direction`; the fan takes `target_cfm`."""
    r = _run({"tool_calls": [
        {"name": "adjust_ventilation",
         "arguments": {"zone": "Zone-4", "rate": "Maximum", "direction": "Upward"}},
    ]})[0]
    assert r["executed"]
    assert set(r["arguments"]) == {"zone_id", "target_cfm"}
    assert isinstance(r["arguments"]["target_cfm"], int)


def test_severity_alias_does_not_downgrade_the_alarm():
    """Regression: `severity: Critical` once fell through to a LEVEL_2 default.

    Quietly lowering an alarm the agent asked to raise is the worst failure this
    module can have, because it looks like success in every log.
    """
    r = _run({"tool_calls": [
        {"name": "trigger_zone_alarm",
         "arguments": {"severity": "Critical", "message": "evacuate"}},
    ]})[0]
    assert r["executed"]
    assert r["arguments"]["alarm_level"] == "LEVEL_3"


def test_unspecified_alarm_level_fails_upward():
    r = _run({"tool_calls": [
        {"name": "trigger_zone_alarm", "arguments": {}},
    ]})[0]
    assert r["arguments"]["alarm_level"] == "LEVEL_3"


def test_zone_id_is_never_taken_from_the_model():
    """A containment action aimed at the wrong zone is worse than none."""
    r = _run({"tool_calls": [
        {"name": "adjust_ventilation",
         "arguments": {"zone_id": "Zone-9", "target_cfm": 4000}},
    ]})[0]
    assert r["arguments"]["zone_id"] == "Zone-4"


def test_non_numeric_airflow_is_clamped_into_range():
    r = _run({"tool_calls": [
        {"name": "adjust_ventilation", "arguments": {"target_cfm": 999999}},
    ]})[0]
    assert r["arguments"]["target_cfm"] == 20000


# -------------------------------------------------------------- the gate
def test_permit_veto_requires_a_deterministic_rejection():
    """A language model does not get to revoke a permit the rule engine cleared."""
    r = _run({"tool_calls": [
        {"name": "veto_permit", "arguments": {"permit_id": "P-402", "reason": "gas"}},
    ]}, permit_rejected=False)[0]
    assert not r["executed"]
    assert "not rejected by the" in r["refused_because"]


def test_restrictive_tools_are_withheld_without_escalation():
    plan = {"tool_calls": [
        {"name": "trigger_zone_alarm", "arguments": {"severity": "Critical"}},
        {"name": "veto_permit", "arguments": {"permit_id": "P-402", "reason": "gas"}},
        {"name": "dispatch_response_team", "arguments": {"team": "ERT"}},
    ]}
    receipts = _run(plan, escalated=False, permit_rejected=False)
    assert all(not r["executed"] for r in receipts)
    assert all("did not escalate" in r["refused_because"] for r in receipts)


def test_ventilation_is_allowed_without_escalation():
    """Purging removes the hazard instead of restricting people, so it runs early."""
    r = _run({"tool_calls": [
        {"name": "adjust_ventilation", "arguments": {"target_cfm": 5000}},
    ]}, escalated=False, permit_rejected=False)[0]
    assert r["executed"]


def test_unregistered_tool_is_refused():
    r = _run({"tool_calls": [{"name": "launch_missile", "arguments": {}}]})[0]
    assert not r["executed"]
    assert "not a registered tool" in r["refused_because"]


def test_duplicate_calls_are_collapsed():
    """The model proposed the same alarm three times in one plan."""
    call = {"name": "trigger_zone_alarm", "arguments": {"severity": "Critical"}}
    receipts = _run({"tool_calls": [call, dict(call), dict(call)]})
    assert [r["executed"] for r in receipts] == [True, False, False]
    assert "duplicate" in receipts[1]["refused_because"]


def test_refusals_are_recorded_not_dropped():
    """Every proposal yields a receipt: the console shows what was refused."""
    plan = {"tool_calls": [
        {"name": "adjust_ventilation", "arguments": {"target_cfm": 5000}},
        {"name": "launch_missile", "arguments": {}},
        {"name": "veto_permit", "arguments": {"reason": "gas"}},
    ]}
    receipts = _run(plan, permit_rejected=False)
    assert len(receipts) == 3
    assert all("elapsed_ms" in r and "proposed" in r for r in receipts)
    assert all(r["executed"] or r.get("refused_because") for r in receipts)


def test_empty_and_missing_plans_are_safe():
    assert _run({"tool_calls": []}) == []
    assert _run({}) == []
    assert _run({"tool_calls": None}) == []


# ------------------------------------------------------ prompt/schema contract
def test_schema_enum_matches_the_registry():
    """The model cannot be offered a tool that does not exist."""
    enum = proposal_schema()["properties"]["tool_calls"]["items"]["properties"]["name"]["enum"]
    assert set(enum) == set(REGISTRY)


def test_catalogue_advertises_real_signatures():
    """Guards against a hand-written prompt drifting from the implementation."""
    cat = tool_catalogue()
    for name, spec in REGISTRY.items():
        assert name in cat
        for arg in spec.args:
            assert arg in cat
