"""Containment tools, and the gate every Gemma proposal passes through.

Gemma 3 cannot invoke these itself -- Ollama has no tool-calling template for
the model, so `tools` on /api/chat is rejected outright. Agents instead *propose*
calls as schema-constrained JSON and this module decides what actually runs.

That constraint pushed the design somewhere better than native tool calling
would have. On a system that can stop work in a live plant, the question is not
"can the model call a function" but "who is accountable when it calls the wrong
one". Here the answer is explicit:

    Gemma proposes  ->  validate arguments  ->  check against the deterministic
                                                verdict  ->  execute or refuse

Every refusal is recorded with its reason, so the console can show what the
agent wanted to do and why it was not allowed to. A rejected proposal is
evidence the interlocks work, not a failure to hide.

The gate exists because the model demonstrably needs it. Asked for a containment
plan for a zone at 12.4 %LEL, `gemma3:latest` returned valid JSON that:

  * named arguments no tool declares (`rate`, `direction`, `severity`)
  * proposed the same alarm three times in one plan
  * cited HAZWOPER, a standard not in this plant's corpus

Shape was perfect; content was not. `format` constrains decoding, and nothing
about decoding knows what a ventilation fan takes as input.
"""
from __future__ import annotations

import time
from typing import Any, Callable

# --------------------------------------------------------------------- tools
#
# Each entry declares the argument names it accepts and their coercion. The
# declaration is the whitelist: an argument the model invents is dropped before
# it reaches the implementation, rather than arriving as an unexpected keyword.


def veto_permit(permit_id: str, zone_id: str, reason: str) -> dict[str, Any]:
    """Revoke a hot-work or confined-space permit."""
    return {
        "status": "REVOKED",
        "permit_id": permit_id,
        "zone_id": zone_id,
        "detail": f"Permit {permit_id} revoked in {zone_id}. Reason: {reason}",
    }


def trigger_zone_alarm(zone_id: str, alarm_level: str) -> dict[str, Any]:
    """Raise the audible/visual alarm for a zone."""
    return {
        "status": "ACTIVATED",
        "zone_id": zone_id,
        "alarm_level": alarm_level,
        "detail": f"{alarm_level} alarm activated in {zone_id}.",
    }


def adjust_ventilation(zone_id: str, target_cfm: int) -> dict[str, Any]:
    """Command forced-draft ventilation to a target airflow."""
    return {
        "status": "EXECUTED",
        "zone_id": zone_id,
        "target_cfm": target_cfm,
        "detail": f"Forced-draft ventilation commanded to {target_cfm} CFM in {zone_id}.",
    }


def dispatch_response_team(zone_id: str, team: str, muster_point: str) -> dict[str, Any]:
    """Send a named response team to a zone."""
    return {
        "status": "DISPATCHED",
        "zone_id": zone_id,
        "team": team,
        "detail": f"{team} dispatched to {zone_id}; muster at {muster_point}.",
    }


def _clamp_cfm(v: Any) -> int:
    """Coerce an airflow figure into the range the fans can actually deliver.

    The model has offered "Maximum" and "Upward" here. Neither is a number, and
    a fan controller given a string does not fail politely.
    """
    try:
        n = int(float(str(v).strip().rstrip("%")))
    except (TypeError, ValueError):
        n = 5000                      # design airflow for a purge
    return max(500, min(n, 20000))


def _clamp_level(v: Any) -> str:
    """Map a free-text severity onto the three levels the plant annunciator has."""
    s = str(v or "").strip().upper()
    if any(k in s for k in ("3", "CRIT", "EVAC", "EMERG", "HIGH")):
        return "LEVEL_3"
    if any(k in s for k in ("2", "WARN", "ALERT", "MED")):
        return "LEVEL_2"
    return "LEVEL_1"


class ToolSpec:
    __slots__ = ("fn", "args", "requires_escalation", "description")

    def __init__(self, fn: Callable[..., dict], args: dict[str, Callable[[Any], Any]],
                 requires_escalation: bool, description: str):
        self.fn = fn
        self.args = args
        self.requires_escalation = requires_escalation
        self.description = description


REGISTRY: dict[str, ToolSpec] = {
    "veto_permit": ToolSpec(
        veto_permit,
        {"permit_id": str, "zone_id": str, "reason": str},
        # Revoking a permit stops work. It may only follow a deterministic
        # rejection, never a model's opinion -- see `authorise`.
        requires_escalation=True,
        description="Revoke an active hot-work or confined-space permit.",
    ),
    "trigger_zone_alarm": ToolSpec(
        trigger_zone_alarm,
        {"zone_id": str, "alarm_level": _clamp_level},
        requires_escalation=True,
        description="Activate the zone alarm at LEVEL_1, LEVEL_2 or LEVEL_3.",
    ),
    "adjust_ventilation": ToolSpec(
        adjust_ventilation,
        {"zone_id": str, "target_cfm": _clamp_cfm},
        # Purging a zone is the one action that is safe to take early: it removes
        # the hazard rather than restricting people, so it does not need the
        # escalation flag.
        requires_escalation=False,
        description="Command forced-draft ventilation to a target CFM.",
    ),
    "dispatch_response_team": ToolSpec(
        dispatch_response_team,
        {"zone_id": str, "team": str, "muster_point": str},
        requires_escalation=True,
        description="Dispatch a named response team to a zone.",
    ),
}


def tool_catalogue() -> str:
    """The tool list as it is shown to Gemma, generated from the registry.

    Written by hand this drifts: the prompt keeps advertising a tool after the
    signature changes, and the model keeps proposing the old arguments. Deriving
    it means the prompt cannot describe a tool that does not exist.
    """
    lines = []
    for name, spec in REGISTRY.items():
        args = ", ".join(spec.args)
        lines.append(f"- {name}({args}): {spec.description}")
    return "\n".join(lines)


def proposal_schema() -> dict[str, Any]:
    """JSON Schema for a Gemma containment plan.

    `enum` on the tool name is the one part of the contract that decoding can
    enforce for us, so it carries real weight: the model cannot invent a tool
    that is not in the registry. Argument names it can and does still invent,
    which is what `_coerce` is for.
    """
    return {
        "type": "object",
        "properties": {
            "reasoning": {"type": "string"},
            "confidence": {"type": "number"},
            "tool_calls": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "enum": list(REGISTRY)},
                        "arguments": {"type": "object"},
                    },
                    "required": ["name", "arguments"],
                },
            },
        },
        "required": ["reasoning", "confidence", "tool_calls"],
    }


# ----------------------------------------------------------------- the gate
class Refusal(Exception):
    """A proposal that will not be executed, carrying the reason why."""


# Arguments the model is never allowed to supply, because they identify real
# things in a real plant. A wrong value here is not a degraded action, it is an
# action against the wrong object -- or a fabricated reference in an audit trail
# that a statutory investigation will later rely on.
#
# `gemma3:latest` produced both failure modes unprompted: a permit reference of
# "HOT-WORK-4-23" for a system that issues no permit numbers, and a muster point
# of "Docking Bay Alpha" for a plant that has no such location. Both were
# plausible, neither was real, and an invented assembly point in an evacuation
# order is the most dangerous output in this file.
_CALLER_AUTHORITATIVE = frozenset({"zone_id", "permit_id", "muster_point"})


def _coerce(name: str, raw: dict[str, Any], zone_id: str,
            permit_id: str | None) -> dict[str, Any]:
    """Fit proposed arguments to the tool's real signature.

    Values that identify plant objects come from the workflow, which holds the
    authoritative copy. Values that are advisory prose -- a reason, a team name --
    may come from the model, since a poor phrasing is visible to the operator
    reading it and cannot misdirect an action.
    """
    spec = REGISTRY[name]
    supplied = {k.lower(): v for k, v in (raw or {}).items()}
    out: dict[str, Any] = {}
    for arg, coerce in spec.args.items():
        if arg == "zone_id":
            out[arg] = zone_id
            continue
        if arg == "permit_id":
            # No permit numbering exists upstream: PermitDecision carries a
            # status, reasons and checks, but no id. So the reference is derived
            # from the zone, which is what the rule engine actually evaluated --
            # "the hot-work permit for Zone-4" -- rather than accepting a number
            # the model made up to fill the field.
            out[arg] = permit_id or f"HOTWORK-{zone_id}"
            continue
        if arg == "muster_point":
            out[arg] = _DEFAULTS["muster_point"]
            continue
        val = supplied.get(arg)
        if val is None:
            val = _from_alias(arg, supplied)
        if val is None:
            val = _DEFAULTS.get(arg)
        if val is None:
            raise Refusal(f"{name} proposed without required argument '{arg}'")
        out[arg] = coerce(val)
    return out


# The names the model actually uses instead of ours, collected from its output.
# A substring match was tried first and is not good enough: `severity` shares no
# substring with `alarm_level`, so a proposal reading "Critical" fell through to
# the default and was executed as LEVEL_2. Silently *lowering* an alarm the agent
# asked to raise is the one failure mode this file exists to prevent, so the
# mapping is explicit and the fallbacks below fail upward.
_ALIASES: dict[str, tuple[str, ...]] = {
    "alarm_level": ("severity", "level", "alarm", "priority", "alarm_severity"),
    "reason": ("justification", "cause", "rationale", "message", "detail", "why"),
    "target_cfm": ("cfm", "airflow", "rate", "flow", "target", "setpoint"),
    "team": ("response_team", "crew", "responders", "unit"),
    "muster_point": ("assembly_point", "muster", "assembly", "location"),
    "permit_id": ("permit", "id", "permit_no", "permit_number"),
}


def _from_alias(arg: str, supplied: dict[str, Any]) -> Any:
    for alias in _ALIASES.get(arg, ()):
        if alias in supplied and supplied[alias] not in (None, ""):
            return supplied[alias]
    # Last resort: a substring relation, which catches spellings the table has
    # not seen yet without inventing a value.
    for k, v in supplied.items():
        if (arg in k or k in arg) and v not in (None, ""):
            return v
    return None


# Applied only when neither the argument nor any alias was supplied. Each one
# errs toward more protection, never less: an unspecified alarm becomes the
# highest level rather than the lowest, because the caller has already been
# authorised to raise one at all.
_DEFAULTS = {
    "reason": "compound hazard threshold exceeded",
    "team": "Emergency Response Team",
    "muster_point": "primary assembly point",
    "alarm_level": "LEVEL_3",
    "target_cfm": 5000,
}


def authorise(name: str, args: dict[str, Any], *, escalated: bool,
              permit_rejected: bool) -> None:
    """Decide whether a validated proposal may run. Raises `Refusal` if not.

    `escalated` and `permit_rejected` both come from the deterministic layer --
    the rule engine and the interlocks, which have already reached a verdict
    before any agent node executes. Gemma's own confidence is deliberately not
    an input here. A 4B model reporting 0.95 confidence on a zone the rule
    engine cleared is not evidence of anything.
    """
    spec = REGISTRY.get(name)
    if spec is None:
        raise Refusal(f"'{name}' is not a registered tool")
    if spec.requires_escalation and not escalated:
        raise Refusal(
            f"{name} withheld: the deterministic risk monitor did not escalate "
            f"this zone, so there is no triggering condition for a restrictive "
            f"action")
    if name == "veto_permit" and not permit_rejected:
        raise Refusal(
            "veto_permit withheld: the permit was not rejected by the "
            "interlocks. A permit is cleared or revoked by the rule engine, "
            "never by a language model")


def execute_plan(
    proposal: dict[str, Any],
    *,
    zone_id: str,
    permit_id: str | None,
    escalated: bool,
    permit_rejected: bool,
) -> list[dict[str, Any]]:
    """Run an agent's containment plan through validation, gate and execution.

    Returns one receipt per proposed call, executed or refused, in the order
    proposed. Refusals are receipts too -- the console renders them, and they are
    the visible proof that the model is not trusted blindly.
    """
    receipts: list[dict[str, Any]] = []
    seen: set[tuple] = set()

    for call in (proposal.get("tool_calls") or []):
        name = str((call or {}).get("name") or "")
        raw = (call or {}).get("arguments") or {}
        receipt: dict[str, Any] = {"tool": name, "proposed": raw}
        started = time.perf_counter()
        try:
            if name not in REGISTRY:
                raise Refusal(f"'{name}' is not a registered tool")
            args = _coerce(name, raw, zone_id, permit_id)

            # The model repeated one alarm three times in a single plan. Executing
            # duplicates would triple-log a single physical action and make the
            # timeline lie about what happened in the plant.
            key = (name, tuple(sorted(args.items(), key=lambda kv: kv[0])))
            if key in seen:
                raise Refusal(f"duplicate {name} call in the same plan, collapsed")
            seen.add(key)

            authorise(name, args, escalated=escalated,
                      permit_rejected=permit_rejected)
            result = REGISTRY[name].fn(**args)
            receipt.update(executed=True, arguments=args, result=result)
        except Refusal as e:
            receipt.update(executed=False, refused_because=str(e))
        except Exception as e:                    # a tool must never break the graph
            receipt.update(executed=False, refused_because=f"tool error: {e}")
        receipt["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
        receipts.append(receipt)

    return receipts
