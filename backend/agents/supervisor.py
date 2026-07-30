"""Autonomous orchestrator: watches every zone and dispatches the agent chain itself.

The workflow endpoint takes a zone and runs the graph against it. That is the
wrong shape for a control room. Nobody in a plant picks a zone from a dropdown
and asks the safety system to have a look -- the system is supposed to be
watching all of them, notice which one is going wrong, and start work on its own.

This module is that loop:

    scan every zone  ->  pick the one that most needs attention  ->  run the
    agent chain against it  ->  publish node-by-node progress  ->  repeat

Three constraints shaped it, all of them about cost.

Generation is slow. A full emergency chain measured 190s with Gemma on CPU, so
this cannot poll-and-run indiscriminately: it dispatches one run at a time, only
for zones above the escalation threshold, and refuses to re-run a zone whose
state has not moved. Without those guards the loop would spend the entire shift
re-deriving the same conclusion about the same zone.

Progress has to be observable. The graph is synchronous and a run outlives any
sane HTTP request, so the dispatch happens on a worker thread and each node
reports its own start and finish into a shared snapshot the API can read at any
instant. That snapshot is what lets the console animate the chain instead of
showing a spinner for three minutes.

Failure must be contained. A crash in here is a monitoring outage, not a plant
outage: the deterministic interlocks and the alert queue are unaffected, so the
loop logs and continues rather than taking the API down.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any, Callable

log = logging.getLogger(__name__)

# Mirrors ESCALATE_RISK in graph.py. Below this the graph deliberately stands
# down, so dispatching a run would spend a minute of inference to be told there
# was no triggering condition.
DISPATCH_RISK = 0.50

# A zone already handled is not re-run until its risk moves by this much. Zone
# telemetry drifts continuously and without a deadband the top zone would be
# re-analysed every cycle on a hundredth of a percent of change.
RERUN_RISK_DELTA = 0.08

# ...or until this many plant minutes have passed, so a zone sitting at a steady
# high risk is still revisited rather than analysed once and forgotten.
RERUN_AFTER_MINUTES = 25

# The chain, in execution order, with the layer each node belongs to. The console
# renders its diagram from this rather than hardcoding a copy -- a node added to
# the graph and not to this list would silently vanish from the display.
NODE_LAYERS: list[dict[str, str]] = [
    {"node": "risk_monitor", "layer": "sensor",
     "label": "Sensor Monitor",
     "detail": "Fuses gas, trend, anomaly and exposure into compound risk. Deterministic."},
    {"node": "permit_intelligence", "layer": "sensor",
     "label": "Permit Interlocks",
     "detail": "Checks live conditions against the hot-work permit. Deterministic."},
    {"node": "compliance", "layer": "retrieval",
     "label": "Compliance RAG",
     "detail": "Retrieves the governing clause, then Gemma states what it requires."},
    {"node": "gemma_containment", "layer": "gemma",
     "label": "Containment Agent",
     "detail": "Gemma proposes containment tool calls; the gate authorises them."},
    {"node": "gemma_reflection", "layer": "gemma",
     "label": "Reflection Agent",
     "detail": "Gemma reviews its own refused proposals and revises."},
    {"node": "gemma_advisor", "layer": "gemma",
     "label": "Advisory Agent",
     "detail": "Turns model risk drivers into an operator briefing."},
    {"node": "emergency_orchestrator", "layer": "response",
     "label": "Response Orchestrator",
     "detail": "Issues evacuation and containment actions, drafts the notification."},
    {"node": "advisory", "layer": "response",
     "label": "Conditional Controls",
     "detail": "Issues monitoring controls when the emergency criteria are not met."},
    {"node": "monitor_only", "layer": "response",
     "label": "Stand Down",
     "detail": "Records a no-intervention decision for a zone below the threshold."},
]

_NODE_META = {n["node"]: n for n in NODE_LAYERS}


class _Run:
    """One dispatch, and how far through the chain it has got."""

    def __init__(self, zone_id: str, zone_name: str, minute: int, risk: float,
                 trigger: str):
        self.zone_id = zone_id
        self.zone_name = zone_name
        self.minute = minute
        self.risk = risk
        self.trigger = trigger
        self.started = time.time()
        self.finished: float | None = None
        # node -> {"state": pending|running|done, "ms": int}
        self.nodes: dict[str, dict[str, Any]] = {}
        self.result: dict[str, Any] | None = None
        self.error: str | None = None

    # ------------------------------------------------------------- progress
    def node_started(self, node: str) -> None:
        self.nodes[node] = {"state": "running", "ms": 0, "at": time.time()}

    def node_finished(self, node: str) -> None:
        rec = self.nodes.get(node)
        if rec:
            rec["state"] = "done"
            rec["ms"] = int((time.time() - rec.pop("at", time.time())) * 1000)

    @property
    def active_node(self) -> str | None:
        for node, rec in self.nodes.items():
            if rec.get("state") == "running":
                return node
        return None

    @property
    def elapsed_ms(self) -> int:
        end = self.finished or time.time()
        return int((end - self.started) * 1000)

    def snapshot(self) -> dict[str, Any]:
        return {
            "zone_id": self.zone_id,
            "zone_name": self.zone_name,
            "minute": self.minute,
            "risk": self.risk,
            "trigger": self.trigger,
            "active_node": self.active_node,
            "elapsed_ms": self.elapsed_ms,
            "running": self.finished is None,
            "error": self.error,
            "nodes": [
                {
                    "node": n["node"],
                    "layer": n["layer"],
                    "label": n["label"],
                    "detail": n["detail"],
                    "state": self.nodes.get(n["node"], {}).get("state", "pending"),
                    "ms": self.nodes.get(n["node"], {}).get("ms", 0),
                }
                for n in NODE_LAYERS
            ],
        }


class Orchestrator:
    """Scans zones, dispatches the chain, and publishes what it is doing."""

    def __init__(self, max_history: int = 12):
        self._lock = threading.RLock()
        self.enabled = True
        self.cycles = 0
        self.dispatched = 0
        self.skipped_reason: str | None = None
        self._current: _Run | None = None
        # The last run that finished, kept separately from `_current`.
        #
        # Without this the console loses an outcome the instant the next dispatch
        # starts: a chain takes minutes, and the panels showing what it decided
        # would blank out mid-read as soon as the loop moved to the next zone.
        # An operator needs the last conclusion to stay on screen while the system
        # works on the following one.
        self._last_completed: _Run | None = None
        self._history: deque[_Run] = deque(maxlen=max_history)
        # zone_id -> (risk_at_last_run, plant_minute_at_last_run)
        self._handled: dict[str, tuple[float, int]] = {}
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------ selection
    def _should_run(self, zone: dict[str, Any], minute: int) -> bool:
        prev = self._handled.get(zone["zone_id"])
        if prev is None:
            return True
        last_risk, last_minute = prev
        if abs(zone["risk"] - last_risk) >= RERUN_RISK_DELTA:
            return True
        # The plant clock wraps at the end of the episode, so compare on the
        # absolute gap: a wrap would otherwise read as a large negative age and
        # suppress the zone for the rest of the replay.
        return abs(minute - last_minute) >= RERUN_AFTER_MINUTES

    def pick_target(self, zones: list[dict[str, Any]], minute: int) -> dict[str, Any] | None:
        """The zone that most needs the chain run against it, or None.

        Highest risk first, which is also the order the alert queue uses, so the
        orchestrator and the operator are looking at the same zone.
        """
        candidates = [z for z in zones if z.get("risk", 0.0) >= DISPATCH_RISK]
        if not candidates:
            self.skipped_reason = (
                f"no zone at or above the {DISPATCH_RISK:.0%} escalation threshold")
            return None
        candidates.sort(key=lambda z: -z["risk"])
        for zone in candidates:
            if self._should_run(zone, minute):
                return zone
        self.skipped_reason = (
            f"{len(candidates)} zone(s) above threshold, all already analysed at "
            f"their current state")
        return None

    # ------------------------------------------------------------- dispatch
    @property
    def busy(self) -> bool:
        with self._lock:
            return self._current is not None and self._current.finished is None

    def dispatch(self, zone: dict[str, Any], minute: int,
                 runner: Callable[[str, _Run], dict[str, Any]]) -> None:
        """Start a run on a worker thread. Returns immediately."""
        risk = zone.get("risk", 0.0)
        trigger = (
            f"gas {zone.get('gas_lel', 0):.2f} %LEL"
            + (" rising" if zone.get("gas_trend", 0) > 0 else "")
            + (", hot work active" if zone.get("hot_work_active") else "")
            + (", maintenance active" if zone.get("maintenance_active") else "")
            + f", {zone.get('workers_in_zone', 0)} in zone"
        )
        run = _Run(zone["zone_id"], zone.get("name", zone["zone_id"]), minute,
                   risk, trigger)
        with self._lock:
            self._current = run
            self.dispatched += 1
            self._handled[zone["zone_id"]] = (risk, minute)
            self.skipped_reason = None

        def _work() -> None:
            try:
                run.result = runner(zone["zone_id"], run)
            except Exception as e:                      # never kill the loop
                run.error = str(e)[:300]
                log.exception("orchestrator run failed for %s", zone["zone_id"])
            finally:
                run.finished = time.time()
                with self._lock:
                    self._last_completed = run
                    self._history.appendleft(run)

        t = threading.Thread(target=_work, name=f"sentinel-orchestrator-{zone['zone_id']}",
                             daemon=True)
        self._thread = t
        t.start()

    # ---------------------------------------------------------- observation
    def instrument(self, node: str, fn: Callable[[dict], dict]) -> Callable[[dict], dict]:
        """Wrap a graph node so it reports its own start and finish.

        Applied in `build_safety_graph`, so a node cannot be added to the graph
        and forgotten here without also being absent from `NODE_LAYERS` -- which
        is visible immediately, because the console draws its diagram from that
        list.
        """
        def wrapped(state: dict) -> dict:
            run = self._current
            if run is not None and run.finished is None:
                run.node_started(node)
                try:
                    return fn(state)
                finally:
                    run.node_finished(node)
            return fn(state)
        wrapped.__name__ = getattr(fn, "__name__", node)
        wrapped.__doc__ = fn.__doc__
        return wrapped

    def snapshot(self, zones: list[dict[str, Any]] | None = None,
                 minute: int = 0) -> dict[str, Any]:
        """Everything the console needs for one frame, in one read."""
        with self._lock:
            # `current` is whatever is executing. `last_completed` is the most
            # recent finished run and carries the result payload, so the outcome
            # panels survive the next dispatch. They are the same run only in the
            # window between a run finishing and the next one starting.
            current = self._current.snapshot() if self._current else None
            done = self._last_completed
            last_completed = done.snapshot() if done else None
            last_result = done.result if done else None
            history = [
                {
                    "zone_id": r.zone_id, "zone_name": r.zone_name,
                    "minute": r.minute, "risk": r.risk,
                    "elapsed_ms": r.elapsed_ms, "error": r.error,
                    "verdict": ((r.result or {}).get("permit_decision") or {}).get("status"),
                    "priority": ((r.result or {}).get("priority") or {}).get("priority"),
                    "executed": sum(
                        1 for t in ((r.result or {}).get("tool_executions") or [])
                        if t.get("executed")),
                    "refused": sum(
                        1 for t in ((r.result or {}).get("tool_executions") or [])
                        if not t.get("executed")),
                }
                for r in self._history
            ]
            handled = dict(self._handled)
            cycles, dispatched, skipped = self.cycles, self.dispatched, self.skipped_reason
            enabled = self.enabled

        # The sensor layer: every zone the orchestrator is watching, and why it
        # is or is not a candidate. This is the row of "sensor agents" in the
        # console, and it is derived from live telemetry rather than a fixture.
        sensors = []
        for z in sorted(zones or [], key=lambda z: -z.get("risk", 0.0)):
            zid = z["zone_id"]
            prev = handled.get(zid)
            state = (
                "alerting" if z.get("risk", 0) >= DISPATCH_RISK else
                "elevated" if z.get("risk", 0) >= DISPATCH_RISK / 2 else "nominal"
            )
            sensors.append({
                "zone_id": zid,
                "zone_name": z.get("name", zid),
                "risk": z.get("risk", 0.0),
                "gas_lel": z.get("gas_lel", 0.0),
                "gas_trend": z.get("gas_trend", 0.0),
                "workers_in_zone": z.get("workers_in_zone", 0),
                "hot_work_active": bool(z.get("hot_work_active")),
                "maintenance_active": bool(z.get("maintenance_active")),
                "state": state,
                "analysed_at_minute": prev[1] if prev else None,
            })

        return {
            "enabled": enabled,
            "busy": current is not None and current.get("running", False),
            "minute": minute,
            "cycles": cycles,
            "dispatched": dispatched,
            "idle_reason": skipped,
            "dispatch_threshold": DISPATCH_RISK,
            "sensors": sensors,
            "current": current,
            "last_completed": last_completed,
            # Returned alongside rather than embedded, so the API layer shapes it
            # through the same response builder the workflow endpoint uses.
            "last_result": last_result,
            "history": history,
            "chain": NODE_LAYERS,
        }


ORCHESTRATOR = Orchestrator()
