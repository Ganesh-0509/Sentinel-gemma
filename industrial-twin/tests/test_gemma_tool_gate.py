"""The gate between a Gemma proposal and a real containment action.

These cases are not hypothetical. Every malformed plan below was produced by
`gemma3:latest` against a Zone-4 hot-work scenario, with decoding already
constrained to the proposal schema. Valid JSON, wrong content -- which is the
whole reason `authorise` exists.
"""
from __future__ import annotations

from sentinel.agents.gemma_nodes import _telemetry_block, gemma_containment
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


def test_invented_permit_number_is_discarded():
    """Regression: the model offered "HOT-WORK-4-23" for a system with no permit
    numbering, and it reached the executed action. A fabricated reference in an
    audit trail is worse than an obviously derived one."""
    r = execute_plan(
        {"tool_calls": [{"name": "veto_permit",
                         "arguments": {"permit_id": "HOT-WORK-4-23", "reason": "gas"}}]},
        zone_id="Zone-4", permit_id=None, escalated=True, permit_rejected=True)[0]
    assert r["executed"]
    assert r["arguments"]["permit_id"] == "HOTWORK-Zone-4"
    # The proposal is still recorded, so the console can show what was asked for.
    assert r["proposed"]["permit_id"] == "HOT-WORK-4-23"


def test_invented_muster_point_is_discarded():
    """The model offered "Docking Bay Alpha". An invented assembly point in an
    evacuation order is the most dangerous output this module can emit."""
    r = _run({"tool_calls": [
        {"name": "dispatch_response_team",
         "arguments": {"team": "Hazmat Response", "muster_point": "Docking Bay Alpha"}},
    ]})[0]
    assert r["executed"]
    assert r["arguments"]["muster_point"] == "primary assembly point"
    # A team name is advisory prose, not an identifier, so it passes through.
    assert r["arguments"]["team"] == "Hazmat Response"


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


# ------------------------------------------------------ prompt construction
def _block(**over):
    base = {"zone": "Blast Furnace 2", "machine_id": "BLF-2", "gas_lel": 1.78,
            "gas_trend": -0.1, "risk": 0.81, "area_class": "ZONE_1"}
    return _telemetry_block({**base, **over})


def test_gas_reading_states_the_comparison_to_the_limit():
    """Regression: the model read "1.78 %LEL" as being at the explosive limit.

    %LEL is a percentage *of* the lower explosive limit, and against a 5.0 limit
    real runs described 1.78 as "above the LEL threshold" and warned of imminent
    explosion. The prompt now makes the comparison instead of leaving it to the
    model's arithmetic.
    """
    from sentinel.rules.engine import HOT_WORK_MAX_LEL

    below = _block(gas_lel=1.78)
    assert "BELOW" in below
    assert f"{HOT_WORK_MAX_LEL:.1f} %LEL hot-work limit" in below
    assert "headroom" in below
    assert "percentage OF the lower explosive limit" in below

    above = _block(gas_lel=10.15)
    assert "AT OR ABOVE" in above
    assert "BELOW" not in above


def test_gas_at_the_limit_reads_as_above_not_below():
    """The boundary belongs on the restrictive side."""
    from sentinel.rules.engine import HOT_WORK_MAX_LEL

    assert "AT OR ABOVE" in _block(gas_lel=HOT_WORK_MAX_LEL)


def test_area_class_is_labelled_as_a_classification_not_a_place():
    """Regression: the model evacuated "Zone 1", reading the electrical area
    class as a location. The zone it should name is the one in `zone`."""
    b = _block(area_class="ZONE_1")
    assert "not a location" in b
    assert "Blast Furnace 2" in b


def test_trend_direction_is_stated_in_words():
    assert "(falling)" in _block(gas_trend=-0.4)
    assert "(rising)" in _block(gas_trend=0.4)
    assert "(steady)" in _block(gas_trend=0.0)


# ------------------------------------------------------------- node wiring
def test_containment_node_uses_the_zone_identifier_not_its_label(monkeypatch):
    """Regression: the gate substituted the display name for the identifier.

    The workflow carries the label in `zone` ("Blast Furnace 2") and the id in
    `machine_id` ("BLF-2"). Reading `zone` first meant a correctly proposed
    "BLF-2" was overwritten with a value no downstream system resolves — the
    substitution built to prevent a wrong-zone action was causing one.
    """
    class _Result:
        payload = {"reasoning": "x", "confidence": 0.5, "tool_calls": [
            {"name": "adjust_ventilation",
             "arguments": {"zone_id": "BLF-2", "target_cfm": 5000}},
        ]}
        model, latency_ms, eval_count, tokens_per_s = "gemma3:latest", 10, 5, 1.0

        def as_meta(self):
            return {"model": self.model, "latency_ms": self.latency_ms,
                    "load_ms": 0, "gen_ms": 10, "eval_count": self.eval_count,
                    "prompt_count": 1, "tokens_per_s": self.tokens_per_s,
                    "truncated": False, "runtime": "ollama (local)"}

    class _Client:
        def structured(self, **_):
            return _Result()

    monkeypatch.setattr("sentinel.agents.gemma_nodes.get_gemma", lambda: _Client())

    out = gemma_containment({
        "zone": "Blast Furnace 2", "machine_id": "BLF-2",
        "escalate": True, "permit_decision": {"status": "REJECTED"},
        "risk": 0.9, "gas_lel": 12.0, "trace": [],
    })
    assert out["tool_executions"][0]["arguments"]["zone_id"] == "BLF-2"


def test_containment_node_records_absence_when_gemma_is_down(monkeypatch):
    """An unreachable model must not break the graph, and must say it was absent."""
    from sentinel.llm.gemma import GemmaUnavailable

    class _Down:
        def structured(self, **_):
            raise GemmaUnavailable("gemma unreachable: connection refused")

    monkeypatch.setattr("sentinel.agents.gemma_nodes.get_gemma", lambda: _Down())

    out = gemma_containment({"zone": "Blast Furnace 2", "machine_id": "BLF-2",
                             "escalate": True, "trace": []})
    assert "tool_executions" not in out          # nothing invented
    assert any("did not run" in line for line in out["trace"])
