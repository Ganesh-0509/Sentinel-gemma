"""Multi-agent safety workflow (LangGraph).

    START -> risk_monitor -> [stand down -> monitor_only -> END | escalate]
                                  |
                          permit_intelligence
                                  |
                             compliance
                                  |
              +-------------------+-------------------+
              |                                       |
       gemma_containment                        advisory
              |                                       |
       gemma_reflection                        gemma_advisor -> END
              |
      emergency_orchestrator -> END

Division of labour -- this is the important design decision:

    DETERMINISTIC agents (no LLM): risk_monitor, permit_intelligence.
        Anything that can stop work or clear work is plain auditable logic. An
        LLM never decides whether a hot-work permit is safe.

    GEMMA agents: gemma_containment (proposes tool calls), gemma_reflection
        (audits its own refused proposals), gemma_advisor (SHAP attributions ->
        operator briefing). See `gemma_nodes.py`.

    LLM agents: compliance (grounded RAG, cites sources), emergency_orchestrator
        (drafts the regulatory notification). Both operate on language, after the
        safety decision has already been made deterministically.

So the agents add autonomy in *coordination and communication*, not in the safety
verdict itself. That is the honest answer to "why agents?".

The Gemma layer keeps that property. `gemma_containment` runs after the permit
verdict and the interlocks are settled, and every action it proposes passes
through the gate in `tools.py`, which authorises against the deterministic
verdict rather than against the model's confidence. Gemma widens what the system
can *do* autonomously without widening what it is allowed to decide.
"""
from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from sentinel.decision.priority import AlertContext, prioritise
from sentinel.llm.provider import LLMUnavailable, get_llm
from sentinel.rules.engine import (
    HOT_WORK_MAX_LEL,
    PermitRequest,
    ProximateHazard,
    ZoneConditions,
    evaluate_interlocks,
    evaluate_permit,
    minutes_to_limit,
)

ESCALATE_RISK = 0.50          # below this the situation is logged, not escalated
EMERGENCY_RISK = 0.85         # at/above this with a rejected permit -> emergency


class SafetyState(TypedDict, total=False):
    # --- inputs ---
    zone: str
    machine_id: str
    risk: float
    lead_time_min: int
    anomaly_score: float
    explanation: str
    gas_lel: float
    gas_trend: float
    o2_pct: float | None
    maintenance_active: bool
    hot_work_active: bool
    workers_in_zone: int
    night_shift: bool
    in_changeover: bool
    area_class: str
    uncovered_heads: int
    ppe_verified: bool
    # Neighbouring zones venting nearby, as dicts from PlantService. Passing
    # these through is what makes the workflow's permit verdict agree with the
    # Permit Intelligence page for the same zone -- it previously evaluated the
    # permit without any spatial context and could disagree with itself.
    proximate_hazards: list
    # --- produced by agents ---
    escalate: bool
    priority: dict
    permit_decision: dict
    interlocks: list
    compliance: dict
    actions: list
    report: str
    trace: list
    # --- produced by the Gemma agent layer (gemma_nodes.py) ---
    gemma_plan: dict          # the containment proposal, as the model returned it
    tool_executions: list     # one receipt per proposal: executed or refused
    gemma_reflection: dict    # the model's review of its own refusals
    gemma_briefing: dict      # SHAP attributions rendered for an operator
    gemma_meta: list          # per-node model + latency telemetry for the console


def _log(state: SafetyState, agent: str, msg: str) -> list:
    return list(state.get("trace", [])) + [f"[{agent}] {msg}"]


# --------------------------------------------------------------- agent nodes
def risk_monitor(state: SafetyState) -> dict:
    """Deterministic: fuse risk + exposure, decide whether to escalate."""
    ctx = AlertContext(
        risk=state.get("risk", 0.0),
        workers_in_zone=state.get("workers_in_zone", 0),
        night_shift=state.get("night_shift", False),
        in_changeover=state.get("in_changeover", False),
        lead_time_min=state.get("lead_time_min"),
        area_class=state.get("area_class", "SAFE"),
        uncovered_heads=(state.get("uncovered_heads", 0)
                         if state.get("ppe_verified", True) else 0),
    )
    pr = prioritise(ctx)
    risk = state.get("risk", 0.0)
    escalate = risk >= ESCALATE_RISK
    # The trace is the audit record of *why*, so it carries the readings the
    # decision was made on, not just its outcome.
    msg = (
        f"Fused compound risk {risk:.0%} with exposure and response capacity.\n"
        f"  * gas {state.get('gas_lel', 0):.2f} %LEL "
        f"({state.get('gas_trend', 0):+.2f} %LEL/min), "
        f"anomaly score {state.get('anomaly_score', 0):.2f}\n"
        f"  * {state.get('workers_in_zone', 0)} worker(s) exposed "
        f"(x{pr['exposure_factor']}), urgency x{pr['urgency_factor']}, "
        f"area {state.get('area_class', 'SAFE')} x{pr['area_factor']}\n"
        f"  * model drivers: {state.get('explanation') or 'n/a'}\n"
        f"  -> priority {pr['priority']} (score {pr['score']}); "
        f"{'ESCALATE -- handing to permit intelligence' if escalate else f'monitor only, below the {ESCALATE_RISK:.0%} escalation threshold'}"
    )
    return {"priority": pr, "escalate": escalate, "trace": _log(state, "RiskMonitor", msg)}


def permit_intelligence(state: SafetyState) -> dict:
    """Deterministic: check live conditions against active/requested permits."""
    cond = ZoneConditions(
        gas_lel=state.get("gas_lel", 0.0),
        o2_pct=state.get("o2_pct"),
        gas_trend=state.get("gas_trend", 0.0),
        maintenance_active=state.get("maintenance_active", False),
        workers_in_zone=state.get("workers_in_zone", 0),
        uncovered_heads=state.get("uncovered_heads", 0),
        ppe_verified=state.get("ppe_verified", True),
        proximate_hazards=[
            ProximateHazard(zone_id=h["zone_id"], distance_m=h["distance_m"],
                            gas_lel=h["gas_lel"], rising=h["rising"])
            for h in (state.get("proximate_hazards") or [])
        ],
    )
    decision = evaluate_permit(
        PermitRequest("Hot Work", zone=state.get("zone", "unknown"),
                      machine_id=state.get("machine_id", "")),
        cond,
        compound_risk=state.get("risk"),
        lead_time_min=state.get("lead_time_min"),
    )
    interlocks = evaluate_interlocks(cond, state.get("hot_work_active", False))

    eta = minutes_to_limit(cond.gas_lel, cond.gas_trend, HOT_WORK_MAX_LEL)
    msg = (
        f"Evaluated a Hot Work permit for {state.get('zone', 'this zone')} against "
        f"live conditions -> {decision.status}.\n"
        + "".join(f"  * {c}\n" for c in decision.checks)
        + (f"  * projected to reach the {HOT_WORK_MAX_LEL:.1f} %LEL hot-work limit "
           f"in ~{eta:.0f} min\n" if eta is not None else "")
        + "".join(f"  ! {r}\n" for r in decision.reasons)
        + (f"  ! {len(interlocks)} standing interlock(s) tripped independently of "
           f"this request\n" if interlocks else "")
        + (f"  -> hot work is CURRENTLY ACTIVE in this zone"
           if state.get("hot_work_active") else "  -> no hot work active right now")
    )
    return {"permit_decision": decision.as_dict(), "interlocks": interlocks,
            "trace": _log(state, "PermitIntelligence", msg)}


def _compliance_question(state: SafetyState) -> str:
    """Build the regulatory question from what is *actually* true of this zone.

    This was previously one hardcoded sentence describing rising gas during
    maintenance with hot work in progress, asked of every zone regardless of
    state. On a zone with none of those conditions the retrieved passages were
    answering a question about a situation that was not happening, which is
    exactly why the answer read like a generic web result rather than a finding
    about this plant. The question now names the zone, the readings and the
    operations in progress, so retrieval and the answer are both specific.
    """
    zone = state.get("zone", "the zone")
    gas = state.get("gas_lel", 0.0)
    trend = state.get("gas_trend", 0.0)
    facts: list[str] = [
        f"combustible gas is {gas:.2f} %LEL and "
        + ("rising" if trend > 0 else "falling" if trend < 0 else "steady")
        + f" at {trend:+.2f} %LEL/min"
    ]
    if state.get("hot_work_active"):
        facts.append("hot work is in progress")
    if state.get("maintenance_active"):
        facts.append("maintenance is active")
    if state.get("in_changeover"):
        facts.append("the shift is mid-changeover")
    if state.get("night_shift"):
        facts.append("it is night shift")
    workers = state.get("workers_in_zone", 0)
    if workers:
        facts.append(f"{workers} worker(s) are inside the zone")
    if state.get("uncovered_heads", 0) and state.get("ppe_verified", True):
        facts.append(f"{state['uncovered_heads']} worker(s) appear to be without head protection")
    status = (state.get("permit_decision") or {}).get("status")
    if status:
        facts.append(f"the hot-work permit request has been assessed as {status}")

    lead = state.get("lead_time_min")
    horizon = (f" The compound-risk model predicts a threshold crossing in about "
               f"{lead} minutes." if lead else "")

    # The permit verdict is settled deterministically before this agent runs.
    # Saying so explicitly stops the model from re-deciding it -- a local 8B
    # model will otherwise "downgrade a REJECTED permit to CONDITIONAL", which
    # is exactly the authority the architecture withholds from it.
    settled = (
        f" The permit verdict is already settled at {status} by the deterministic "
        f"interlocks; do not re-decide it, restate it, or propose a different "
        f"status. Explain what the standard requires given that verdict."
        if status else ""
    )

    return (
        f"In {zone}: " + "; ".join(facts) + ". "
        f"Predicted probability of an incident within the forecast horizon is "
        f"{state.get('risk', 0):.0%}.{horizon}{settled} "
        "What does the work permit standard require in these specific conditions, "
        "and what must the shift in-charge do now?"
    )


def compliance(state: SafetyState) -> dict:
    """LLM + RAG: what does the governing standard require here?"""
    from sentinel.rag.assistant import ComplianceAssistant
    question = _compliance_question(state)
    try:
        assistant = ComplianceAssistant()
        ans = assistant.ask(question)
        payload = ans.as_dict()
        # Carry the retrieved chunks through so the API can surface real
        # citations. Without these the console rendered a wall of text with no
        # sources attached, which is indistinguishable from an ungrounded answer.
        payload["chunks"] = [
            {"standard": c.standard, "section": c.section,
             "provenance": c.provenance, "score": float(c.score),
             "kind": c.kind}
            for c in ans.chunks
        ]
        srcs = ", ".join(dict.fromkeys(c.standard for c in ans.chunks)) or "none"
        msg = (f"Retrieved {len(ans.chunks)} passage(s) from the regulation corpus "
               f"and answered via {ans.backend}.\n"
               f"  * question put to the corpus: {question}\n"
               f"  * sources: {srcs}\n"
               f"  * grounded: {ans.grounded}")
    except Exception as e:                      # never let the assistant break the workflow
        payload = {"question": question, "answer": f"compliance lookup unavailable: {e}",
                   "citations": [], "chunks": [], "grounded": False, "backend": "none",
                   "confidence": "none"}
        msg = (f"Compliance lookup unavailable ({e}). The deterministic interlocks "
               f"above are unaffected and still enforce.")
    return {"compliance": payload, "trace": _log(state, "ComplianceAgent", msg)}


def emergency_orchestrator(state: SafetyState) -> dict:
    """LLM-assisted: coordinate the first ten minutes and draft the notification."""
    zone = state.get("zone", "unknown")
    workers = state.get("workers_in_zone", 0)
    actions = [
        f"SUSPEND all hot work in {zone} and adjoining areas (remove ignition sources).",
        f"EVACUATE {workers} worker(s) from {zone} via designated routes, crosswind.",
        "ACCOUNT for all personnel at the assembly point against permit and roster records.",
        "ALERT emergency response team + control room on the designated channel.",
        "ISOLATE the suspected release source remotely where safe to do so.",
        "PRESERVE evidence: freeze process trends, gas readings, alarm/interlock history "
        "and active-permit state for the statutory investigation.",
    ]

    from datetime import datetime, timezone
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    cites = "; ".join(state.get("compliance", {}).get("citations", [])) or "n/a"
    prompt = (
        "Draft a factual preliminary incident notification for a plant safety regulator.\n\n"
        f"Detected at: {stamp}\n"
        f"Zone: {zone}\nEquipment: {state.get('machine_id', 'n/a')}\n"
        f"Predicted incident probability: {state.get('risk', 0):.0%}\n"
        f"Predicted time to threshold: ~{state.get('lead_time_min', 'n/a')} minutes\n"
        f"Gas (point sensor): {state.get('gas_lel', 0):.1f} %LEL, "
        f"trend {state.get('gas_trend', 0):+.2f} %LEL/min\n"
        f"Maintenance active: {state.get('maintenance_active')}\n"
        f"Hot work active: {state.get('hot_work_active')}\n"
        f"Workers in zone: {workers}\n"
        f"Model attribution: {state.get('explanation', 'n/a')}\n"
        f"Permit decision: {state.get('permit_decision', {}).get('status', 'n/a')}\n"
        f"References: {cites}\n\n"
        "Write 4-6 short factual sentences in plain prose: what was detected, when, on "
        "what evidence, and what actions were initiated. Use the exact timestamp given "
        "above. NEVER write placeholders such as [date] or [time] -- every field you need "
        "is supplied. Note that hot work was active and has been ordered suspended. End by "
        "stating plainly that this is a preliminary automated notification pending human "
        "verification. Do not speculate about cause or blame. No headings, no bullet points."
    )
    try:
        report = get_llm().generate(prompt, system="You write precise, factual regulatory "
                                                   "notifications. No speculation.")
    except LLMUnavailable:
        report = (f"PRELIMINARY AUTOMATED NOTIFICATION (no language model available)\n"
                  f"Zone {zone}: compound risk {state.get('risk', 0):.0%}, predicted "
                  f"threshold crossing in ~{state.get('lead_time_min', 'n/a')} min. "
                  f"Gas {state.get('gas_lel', 0):.1f} %LEL rising during active "
                  f"maintenance with hot work in progress. Evacuation and hot-work "
                  f"suspension initiated. Pending human verification.")
    status = (state.get("permit_decision") or {}).get("status", "n/a")
    trigger = ("permit REJECTED" if status == "REJECTED"
               else f"risk >= {EMERGENCY_RISK:.0%}" if state.get("risk", 0) >= EMERGENCY_RISK
               else "priority CRITICAL")
    return {"actions": actions, "report": report.strip(),
            "trace": _log(state, "EmergencyOrchestrator",
                          f"Emergency path taken ({trigger}).\n"
                          f"  * {len(actions)} response action(s) initiated for "
                          f"{workers} worker(s) in {zone}\n"
                          f"  * preliminary regulatory notification drafted at {stamp} "
                          f"via {get_llm().backend}, pending human verification")}


def advisory(state: SafetyState) -> dict:
    """Conditional controls, chosen from what is actually happening in the zone."""
    zone = state.get("zone", "the zone")
    gas, trend = state.get("gas_lel", 0.0), state.get("gas_trend", 0.0)
    eta = minutes_to_limit(gas, trend, HOT_WORK_MAX_LEL)

    actions = [
        f"MONITOR {zone} continuously: gas is {gas:.2f} %LEL at {trend:+.2f} %LEL/min "
        f"against the {HOT_WORK_MAX_LEL:.1f} %LEL hot-work limit."
    ]
    if eta is not None:
        actions.append(
            f"RE-TEST the atmosphere every 5 minutes -- at the current slope the "
            f"hot-work limit is reached in ~{eta:.0f} minutes."
        )
    if state.get("hot_work_active"):
        actions.append(
            f"POST a standby firewatch with extinguishing media for the duration of "
            f"the hot work, and suspend on the first reading at or above "
            f"{HOT_WORK_MAX_LEL:.1f} %LEL."
        )
    if state.get("maintenance_active"):
        actions.append(
            "CONFIRM isolation and blinding of the equipment under maintenance before "
            "the permit is extended."
        )
    if state.get("uncovered_heads", 0) and state.get("ppe_verified", True):
        actions.append(
            f"VERIFY head protection on site: the vision layer counts "
            f"{state['uncovered_heads']} worker(s) without a helmet."
        )
    if state.get("night_shift") or state.get("in_changeover"):
        actions.append(
            "BRIEF the incoming shift explicitly on this zone -- degraded response "
            "capacity is already weighted into its queue position."
        )
    actions.append("RE-TEST the atmosphere before any permit extension or renewal.")

    return {"actions": actions,
            "trace": _log(state, "Advisory",
                          f"Conditions do not meet the emergency criteria "
                          f"(risk < {EMERGENCY_RISK:.0%}, permit not rejected, priority "
                          f"not CRITICAL), so {len(actions)} conditional control(s) were "
                          f"issued and no evacuation was ordered.")}


def monitor_only(state: SafetyState) -> dict:
    """Terminal node for the stand-down path.

    Previously the graph simply ran to END here, so a low-risk zone produced a
    single trace line and four empty panels -- the console looked broken rather
    than reassuring. A stand-down is a decision, and it gets recorded as one.
    """
    zone = state.get("zone", "the zone")
    gas, trend = state.get("gas_lel", 0.0), state.get("gas_trend", 0.0)
    actions = [
        f"NO INTERVENTION required in {zone} at this minute: compound risk "
        f"{state.get('risk', 0):.0%} is below the {ESCALATE_RISK:.0%} escalation "
        f"threshold.",
        f"CONTINUE routine surveillance: gas {gas:.2f} %LEL at {trend:+.2f} %LEL/min, "
        f"{state.get('workers_in_zone', 0)} worker(s) in zone.",
        "RE-EVALUATE automatically on the next plant minute -- the risk model scores "
        "this zone continuously, so no manual re-check is needed.",
    ]
    return {"actions": actions,
            "trace": _log(state, "StandDown",
                          f"Stood down without escalation. The permit, compliance and "
                          f"orchestration agents were deliberately not invoked: running "
                          f"them on a zone below the escalation threshold would produce "
                          f"advice with no triggering condition behind it.")}


# ------------------------------------------------------------------- routing
def route_after_risk(state: SafetyState) -> str:
    return "escalate" if state.get("escalate") else "stand_down"


def route_after_compliance(state: SafetyState) -> str:
    status = state.get("permit_decision", {}).get("status")
    critical = state.get("priority", {}).get("priority") == "CRITICAL"
    if status == "REJECTED" or state.get("risk", 0) >= EMERGENCY_RISK or critical:
        return "emergency"
    return "advisory"


def build_safety_graph():
    from sentinel.agents.gemma_nodes import (
        gemma_advisor,
        gemma_containment,
        gemma_reflection,
    )

    g = StateGraph(SafetyState)
    g.add_node("risk_monitor", risk_monitor)
    g.add_node("permit_intelligence", permit_intelligence)
    g.add_node("compliance", compliance)
    g.add_node("gemma_containment", gemma_containment)
    g.add_node("gemma_reflection", gemma_reflection)
    g.add_node("emergency_orchestrator", emergency_orchestrator)
    g.add_node("advisory", advisory)
    g.add_node("gemma_advisor", gemma_advisor)
    g.add_node("monitor_only", monitor_only)

    g.set_entry_point("risk_monitor")
    g.add_conditional_edges("risk_monitor", route_after_risk,
                            {"escalate": "permit_intelligence",
                             "stand_down": "monitor_only"})
    g.add_edge("permit_intelligence", "compliance")
    g.add_conditional_edges("compliance", route_after_compliance,
                            {"emergency": "gemma_containment", "advisory": "advisory"})
    # Containment proposes and executes through the gate, then reviews its own
    # refusals, and only then does the deterministic orchestrator list the human
    # response actions and draft the notification. That order matters: the
    # notification should describe what was actually done to the plant, so it has
    # to be written after the tools have run.
    g.add_edge("gemma_containment", "gemma_reflection")
    g.add_edge("gemma_reflection", "emergency_orchestrator")
    g.add_edge("emergency_orchestrator", END)
    # The advisory path stays cheap: one Gemma call to turn the model's drivers
    # into a briefing, after the deterministic conditional controls are chosen.
    g.add_edge("advisory", "gemma_advisor")
    g.add_edge("gemma_advisor", END)
    g.add_edge("monitor_only", END)
    return g.compile()


def run_safety_workflow(state: dict[str, Any]) -> dict:
    return build_safety_graph().invoke(state)
