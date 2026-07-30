"""Gemma agent nodes: the reasoning layer above the deterministic core.

These nodes are added to the existing safety graph rather than replacing any of
it. The division in `graph.py` is deliberate and stays: `risk_monitor` and
`permit_intelligence` reach their verdict with plain auditable logic, and no
model can clear or stop work on its own. What Gemma adds sits on top of a verdict
that has already been made:

    gemma_containment  proposes containment actions, which `tools.authorise`
                       then permits or refuses against that verdict
    gemma_reflection   reads its own refused proposals and revises the plan
    gemma_advisor      turns SHAP attributions into something a shift in-charge
                       can act on at 3am

Latency is the design constraint. Generation was measured at 10.7 tok/s with the
model on CPU and roughly 84 tok/s of prompt eval, so a long prompt is nearly free
and a long answer is not. Every node below pays for its output in seconds of an
operator's attention, which is why the schemas are tight, the token caps are low,
and there are three nodes rather than five.

Each node degrades to a recorded absence. If Gemma is unreachable the graph still
completes, the deterministic actions still fire, and the trace says the agent did
not run instead of pretending it did.
"""
from __future__ import annotations

from typing import Any

from sentinel.agents.tools import (
    execute_plan,
    proposal_schema,
    tool_catalogue,
)
from sentinel.llm.gemma import GemmaUnavailable, get_gemma

# Output caps, in tokens. Sized from the schema each node has to fill, not
# guessed: a cap below what the schema needs produces valid-so-far JSON that
# fails to parse, which costs the full generation time and yields nothing.
CONTAINMENT_TOKENS = 300
REFLECTION_TOKENS = 220
ADVISORY_TOKENS = 260


def _telemetry_block(state: dict[str, Any]) -> str:
    """The zone as Gemma sees it.

    Prompt tokens are cheap relative to generation, so this stays explicit and
    spends them where the model has been observed to go wrong.

    Two things it gets wrong without help. First, `%LEL` is a percentage *of* the
    lower explosive limit, and a bare "1.78 %LEL" gets read as being at the
    explosive limit -- runs described a zone at 1.78 against a 5.0 hot-work limit
    as "above the LEL threshold" and warned of imminent explosion. So the reading
    is stated with the limits beside it and with the comparison already made.

    Second, `area_class` is an electrical area classification (ZONE_1, ZONE_2),
    and the model reads it as a place and evacuates "Zone 1". It is labelled as a
    classification and the zone is named on the same line.
    """
    lead = state.get("lead_time_min")
    permit = (state.get("permit_decision") or {}).get("status", "not assessed")
    interlocks = state.get("interlocks") or []
    gas = state.get("gas_lel", 0.0)
    trend = state.get("gas_trend", 0.0)

    # Imported here rather than at module scope: the limits belong to the rule
    # engine, and reading them from it means the prompt cannot drift from the
    # threshold the interlocks actually enforce.
    from sentinel.rules.engine import HOT_WORK_MAX_LEL

    if gas >= HOT_WORK_MAX_LEL:
        verdict = f"AT OR ABOVE the {HOT_WORK_MAX_LEL:.1f} %LEL hot-work limit"
    else:
        headroom = HOT_WORK_MAX_LEL - gas
        verdict = (f"BELOW the {HOT_WORK_MAX_LEL:.1f} %LEL hot-work limit, "
                   f"with {headroom:.2f} %LEL of headroom")

    lines = [
        f"Zone: {state.get('zone', 'unknown')} "
        f"(identifier {state.get('machine_id', 'n/a')})",
        "Combustible gas is measured as a percentage OF the lower explosive "
        "limit, so 100 %LEL would be the explosive limit itself.",
        f"Combustible gas: {gas:.2f} %LEL -- {verdict}. "
        f"Trend {trend:+.2f} %LEL/min "
        f"({'rising' if trend > 0 else 'falling' if trend < 0 else 'steady'}).",
        f"Compound risk (model): {state.get('risk', 0):.0%}",
        f"Predicted time to threshold: "
        f"{f'~{lead} min' if lead else 'no crossing predicted'}",
        f"Workers in zone: {state.get('workers_in_zone', 0)}",
        f"Hot work active: {bool(state.get('hot_work_active'))}",
        f"Maintenance active: {bool(state.get('maintenance_active'))}",
        f"Shift changeover: {bool(state.get('in_changeover'))}",
        f"Night shift: {bool(state.get('night_shift'))}",
        # Named as a classification, not a location. This is an electrical area
        # class under the hazardous-area standard, not somewhere to evacuate to.
        f"Electrical area classification (not a location): "
        f"{state.get('area_class', 'SAFE')}",
        f"Model risk drivers (SHAP): {state.get('explanation') or 'n/a'}",
        f"Permit verdict from deterministic interlocks: {permit}",
    ]
    if interlocks:
        lines.append(f"Standing interlocks tripped: {len(interlocks)}")
        lines += [f"  - {i}" for i in interlocks[:4]]
    if state.get("uncovered_heads") and state.get("ppe_verified", True):
        lines.append(f"Workers without head protection (vision): "
                     f"{state['uncovered_heads']}")
    return "\n".join(lines)


def _record_meta(state: dict[str, Any], node: str, result) -> list:
    """Accumulate per-node model telemetry for the console status bar."""
    entry = {"node": node, **result.as_meta()}
    return list(state.get("gemma_meta") or []) + [entry]


def _log(state: dict[str, Any], agent: str, msg: str) -> list:
    return list(state.get("trace", [])) + [f"[{agent}] {msg}"]


# --------------------------------------------------------- containment agent
_CONTAINMENT_SYSTEM = """You are the Emergency Containment agent on an industrial plant safety console.

A deterministic rule engine has ALREADY decided whether work is permitted. Do not
re-decide it, restate a different permit status, or argue with it. Your job is to
propose which containment tools to invoke given that verdict.

Available tools -- use these names and these argument names exactly:
{catalogue}

Rules:
- Propose only actions justified by the readings you are given.
- Never propose the same tool twice.
- Cite only conditions present in the telemetry. Do not name regulations.
- Keep `reasoning` to two sentences.
- Never invent permit numbers, assembly points or other plant identifiers. Omit
  those arguments; the system fills them from its own records.

Some proposals may be refused by the safety gate. That is expected."""


def gemma_containment(state: dict[str, Any]) -> dict:
    """Gemma proposes containment; the gate in `tools.py` decides what runs."""
    permit_status = (state.get("permit_decision") or {}).get("status")
    escalated = bool(state.get("escalate"))
    permit_rejected = permit_status == "REJECTED"

    system = _CONTAINMENT_SYSTEM.format(catalogue=tool_catalogue())
    user = (
        f"{_telemetry_block(state)}\n\n"
        "Propose the containment tool calls required now."
    )

    try:
        result = get_gemma().structured(
            system=system, user=user, schema=proposal_schema(),
            max_tokens=CONTAINMENT_TOKENS)
    except GemmaUnavailable as e:
        # An absent agent is recorded as absent. The deterministic response
        # actions in `emergency_orchestrator` are unaffected and still fire.
        return {"trace": _log(state, "GemmaContainment",
                              f"Agent did not run ({e}). Deterministic interlocks "
                              f"and response actions are unaffected.")}

    proposal = result.payload
    receipts = execute_plan(
        proposal,
        # `machine_id`, not `zone`. The workflow is handed the display name in
        # `zone` ("Blast Furnace 2") and the identifier in `machine_id` ("BLF-2"),
        # and a tool argument wants the identifier. Taking `zone` first meant the
        # gate overwrote a correctly-proposed "BLF-2" with the human label -- the
        # substitution meant to protect against a wrong zone was itself writing a
        # value no downstream system could resolve.
        zone_id=state.get("machine_id") or state.get("zone") or "unknown",
        permit_id=(state.get("permit_decision") or {}).get("permit_id"),
        escalated=escalated,
        permit_rejected=permit_rejected,
    )
    ran = [r for r in receipts if r["executed"]]
    refused = [r for r in receipts if not r["executed"]]

    msg = (
        f"Gemma proposed {len(receipts)} containment action(s); "
        f"{len(ran)} executed, {len(refused)} refused by the safety gate.\n"
        f"  * model: {result.model} ({result.latency_ms} ms, "
        f"{result.eval_count} tok @ {result.tokens_per_s} tok/s, local)\n"
        f"  * agent reasoning: {str(proposal.get('reasoning', '')).strip()}\n"
        f"  * self-reported confidence: {proposal.get('confidence', 'n/a')} "
        f"(not an input to the gate)\n"
        + "".join(f"  + EXECUTED {r['tool']}({_fmt_args(r.get('arguments'))})\n"
                  for r in ran)
        + "".join(f"  ! REFUSED  {r['tool']}: {r['refused_because']}\n"
                  for r in refused)
    )
    return {
        "gemma_plan": proposal,
        "tool_executions": receipts,
        "gemma_meta": _record_meta(state, "containment", result),
        "trace": _log(state, "GemmaContainment", msg),
    }


def _fmt_args(args: dict[str, Any] | None) -> str:
    if not args:
        return ""
    return ", ".join(f"{k}={v!r}" for k, v in args.items())


# ---------------------------------------------------------- reflection agent
_REFLECTION_SYSTEM = """You are the same containment agent, now reviewing your own plan.

The safety gate refused some of your proposed actions. The gate is authoritative
and its refusals are final.

Answer with:
- `disputes_refusal`: almost always false. Set it true ONLY if a refusal reason
  states something factually wrong about the readings you were given.
- `correction`: what a human supervisor should do now, in two sentences. This must
  NOT restate, rephrase or route around a refused action. If a permit revocation
  was refused, do not recommend stopping, suspending or shutting down the work it
  covers -- recommend what to monitor and who to escalate to instead.
- `residual_risk`: what remains unaddressed after the executed actions.

Rules:
- Use only the readings given. Do not describe gas as elevated, high or above a
  limit unless the telemetry above says it is above the limit.
- Refer to the zone only by the name given. Never invent or infer a location.
- Do not name regulations."""

# `disputes_refusal` rather than `accepted`, and phrased so the common case is the
# default. Asked to set `accepted: true` when it agreed with the gate, the model
# returned false while its own `correction` text read "the safety gate correctly
# identified..." -- the boolean contradicted the prose beside it. Inverting the
# polarity asks it to flag an exception instead of confirming a norm, and the
# console renders the flag only when raised rather than labelling every run from a
# field a 4B model fills inconsistently.
_REFLECTION_SCHEMA = {
    "type": "object",
    "properties": {
        "disputes_refusal": {"type": "boolean"},
        "correction": {"type": "string"},
        "residual_risk": {"type": "string"},
    },
    "required": ["disputes_refusal", "correction", "residual_risk"],
}


def gemma_reflection(state: dict[str, Any]) -> dict:
    """Gemma audits its own refused proposals and revises.

    This runs only when something was actually refused. A reflection step with
    nothing to reflect on burns twenty seconds to conclude that the plan was
    fine, and teaches an operator to skip reading the panel.
    """
    receipts = state.get("tool_executions") or []
    refused = [r for r in receipts if not r["executed"]]
    if not refused:
        return {"trace": _log(state, "GemmaReflection",
                              "No proposal was refused, so no revision was "
                              "required. The plan stands as executed.")}

    ran = [r for r in receipts if r["executed"]]
    user = (
        f"{_telemetry_block(state)}\n\n"
        f"Your plan was: {str((state.get('gemma_plan') or {}).get('reasoning', '')).strip()}\n\n"
        "Executed:\n"
        + ("".join(f"  - {r['tool']}({_fmt_args(r.get('arguments'))})\n" for r in ran)
           or "  - nothing\n")
        + "Refused by the safety gate:\n"
        + "".join(f"  - {r['tool']}: {r['refused_because']}\n" for r in refused)
        + "\nReview and revise."
    )

    try:
        result = get_gemma().structured(
            system=_REFLECTION_SYSTEM, user=user, schema=_REFLECTION_SCHEMA,
            max_tokens=REFLECTION_TOKENS)
    except GemmaUnavailable as e:
        return {"trace": _log(state, "GemmaReflection",
                              f"Revision step did not run ({e}). The executed "
                              f"actions and refusals above stand as recorded.")}

    p = result.payload
    disputed = bool(p.get("disputes_refusal"))
    msg = (
        f"Reviewed {len(refused)} refused proposal(s) against the executed plan.\n"
        f"  * model: {result.model} ({result.latency_ms} ms, local)\n"
        + (f"  * DISPUTES a refusal as factually wrong -- the refusal still "
           f"stands; the gate is authoritative\n" if disputed else
           f"  * accepted the gate's refusals\n")
        + f"  * revised recommendation: {str(p.get('correction', '')).strip()}\n"
        f"  * residual risk: {str(p.get('residual_risk', '')).strip()}"
    )
    return {
        "gemma_reflection": p,
        "gemma_meta": _record_meta(state, "reflection", result),
        "trace": _log(state, "GemmaReflection", msg),
    }


# ------------------------------------------------------------ advisory agent
_ADVISORY_SYSTEM = """You are the Operator Advisory agent on an industrial plant safety console.

You are given a machine-learning risk score and the SHAP feature attributions
behind it. Translate them into a briefing a shift in-charge can act on
immediately. They are not a data scientist: never mention SHAP, features,
attributions, models or scores.

Answer with:
- `headline`: one sentence naming the hazard and the zone
- `why_now`: what combination of conditions is driving this, in plain language
- `watch`: the single reading to watch, and what value would change the picture

Be concrete and use the numbers given. Do not name regulations or invent
readings you were not given."""

_ADVISORY_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "why_now": {"type": "string"},
        "watch": {"type": "string"},
    },
    "required": ["headline", "why_now", "watch"],
}


def gemma_advisor(state: dict[str, Any]) -> dict:
    """Turn SHAP attributions into an operator briefing."""
    user = (
        f"{_telemetry_block(state)}\n\n"
        "Brief the shift in-charge on this zone."
    )
    try:
        result = get_gemma().structured(
            system=_ADVISORY_SYSTEM, user=user, schema=_ADVISORY_SCHEMA,
            max_tokens=ADVISORY_TOKENS)
    except GemmaUnavailable as e:
        return {"trace": _log(state, "GemmaAdvisor",
                              f"Briefing not generated ({e}). The conditional "
                              f"controls listed above are unaffected.")}

    p = result.payload
    msg = (
        f"Translated {state.get('risk', 0):.0%} compound risk and its model "
        f"drivers into an operator briefing.\n"
        f"  * model: {result.model} ({result.latency_ms} ms, "
        f"{result.eval_count} tok @ {result.tokens_per_s} tok/s, local)\n"
        f"  * {str(p.get('headline', '')).strip()}\n"
        f"  * why now: {str(p.get('why_now', '')).strip()}\n"
        f"  * watch: {str(p.get('watch', '')).strip()}"
    )
    return {
        "gemma_briefing": p,
        "gemma_meta": _record_meta(state, "advisory", result),
        "trace": _log(state, "GemmaAdvisor", msg),
    }
