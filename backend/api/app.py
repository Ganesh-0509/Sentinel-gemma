"""Sentinel-Gemma REST API.

Design notes:
  * The safety-critical path (forecaster + deterministic rule engine) never depends
    on the LLM. /compliance and /workflow degrade; /zones and /permits/evaluate do not.
  * Every response is a declared Pydantic model, so /docs is a usable integration
    contract rather than a debug page.
  * Errors return RFC-7807-style problem detail bodies with a stable `type`.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from sentinel import __version__
from sentinel import config as C
from sentinel.api import schemas as S
from sentinel.api.service import plant
from sentinel.geo.site import PROXIMITY_RADIUS_M
from sentinel.llm.provider import get_llm
from sentinel.rules.engine import (
    PermitRequest,
    ProximateHazard,
    ZoneConditions,
    evaluate_permit,
)

ROOT = Path(__file__).resolve().parents[2]
log = logging.getLogger("sentinel.clock")

DESCRIPTION = """
Compound industrial safety intelligence.

Fuses gas, pressure, temperature, vibration and operational context (permits,
maintenance) into a forward-looking risk forecast, explains every alert with SHAP,
enforces deterministic permit interlocks, and coordinates response through a
multi-agent workflow.

**Safety contract:** the machine-learning layer may *escalate or reject* work. It can
never approve work that the deterministic gas/oxygen interlocks have rejected.
"""


def _clock_interval() -> float:
    """Wall-clock seconds per plant minute, overridable at runtime."""
    raw = os.environ.get("SENTINEL_CLOCK_SECONDS")
    if not raw:
        return float(C.CLOCK_SECONDS_PER_MINUTE)
    try:
        return max(0.05, float(raw))
    except ValueError:
        log.warning("ignoring invalid SENTINEL_CLOCK_SECONDS=%r", raw)
        return float(C.CLOCK_SECONDS_PER_MINUTE)


async def _run_clock(interval: float) -> None:
    """Advance the plant clock forever, so the console is live on arrival.

    A real control room does not pause because nobody is looking at it. The clock
    is server state, so every page and every connected client sees the same
    minute without any of them having to drive it. It wraps at the end of the
    episode and replays, which is what makes the console continuously running
    rather than a recording that stops.

    A failure here must never take the API down: the plant state is still
    perfectly readable at a frozen minute, so we log and keep going.
    """
    plant.seconds_per_minute = interval
    plant.clock_running = True
    try:
        while True:
            await asyncio.sleep(interval)
            if not plant.ready:
                continue
            try:
                # Off the event loop: a tick now also diffs the alert queue to
                # write the alert log, which re-scores every zone through SHAP.
                # That is only tens of milliseconds, but it is CPU-bound work
                # and running it inline would stall every in-flight request for
                # its duration -- badly so at a fast SENTINEL_CLOCK_SECONDS,
                # where the tick interval approaches the work itself.
                await asyncio.to_thread(plant.tick, 1)
            except Exception:
                log.exception("plant clock tick failed; clock continues")
    except asyncio.CancelledError:
        raise
    finally:
        plant.clock_running = False


def _orchestrator_interval() -> float:
    """Seconds between orchestrator scans.

    A scan is cheap -- it reads zone state the clock has already computed. The
    expensive part is a dispatch, and that is rate-limited by the risk threshold
    and the re-run deadband in `supervisor`, not by this interval. Five seconds
    keeps the console feeling live without the loop being the thing that decides
    how often Gemma runs.
    """
    raw = os.environ.get("SENTINEL_ORCHESTRATOR_SECONDS")
    try:
        return max(1.0, float(raw)) if raw else 5.0
    except ValueError:
        log.warning("ignoring invalid SENTINEL_ORCHESTRATOR_SECONDS=%r", raw)
        return 5.0


async def _run_orchestrator(interval: float) -> None:
    """Watch every zone and dispatch the agent chain without being asked.

    This is what makes the console autonomous rather than a query tool: no
    operator picks a zone, and no page load triggers analysis. The loop notices
    which zone is deteriorating and starts work on it.

    Only one run is in flight at a time. A full emergency chain measured 190s with
    Gemma on CPU, and running several concurrently would put every one of them
    behind the same busy model while making the console look like it is doing more
    than it is.
    """
    from sentinel.agents.supervisor import ORCHESTRATOR

    while True:
        await asyncio.sleep(interval)
        if not plant.ready or not ORCHESTRATOR.enabled:
            continue
        try:
            ORCHESTRATOR.cycles += 1
            if ORCHESTRATOR.busy:
                continue
            zones = plant.zone_states()
            target = ORCHESTRATOR.pick_target(zones, plant.minute)
            if target is None:
                continue
            log.info("orchestrator dispatching %s at %.0f%% risk",
                     target["zone_id"], target["risk"] * 100)
            # The graph is synchronous and CPU/model-bound; `dispatch` puts it on
            # a worker thread so the event loop keeps serving the console the
            # progress snapshot while the chain runs.
            ORCHESTRATOR.dispatch(
                target, plant.minute,
                runner=lambda zid, _run: _execute_workflow(zid))
        except asyncio.CancelledError:
            raise
        except Exception:
            # A monitoring outage, not a plant outage: interlocks and the alert
            # queue are unaffected, so log and keep watching.
            log.exception("orchestrator cycle failed; loop continues")


@asynccontextmanager
async def lifespan(app: FastAPI):
    plant.startup()
    interval = _clock_interval()
    task = asyncio.create_task(_run_clock(interval), name="sentinel-plant-clock")
    log.info("plant clock started: 1 plant minute per %.2fs wall clock", interval)
    orch_interval = _orchestrator_interval()
    orch = asyncio.create_task(_run_orchestrator(orch_interval),
                              name="sentinel-orchestrator")
    log.info("autonomous orchestrator started: scanning every %.1fs", orch_interval)
    try:
        yield
    finally:
        for t in (task, orch):
            t.cancel()
        for t in (task, orch):
            with contextlib.suppress(asyncio.CancelledError):
                await t


app = FastAPI(
    title="Sentinel-Gemma",
    version=__version__,
    description=DESCRIPTION,
    lifespan=lifespan,
    contact={"name": "Sentinel-Gemma"},
    license_info={"name": "See repository LICENSE"},
    openapi_tags=[
        {"name": "system", "description": "Health and readiness."},
        {"name": "plant", "description": "Live zone telemetry and risk state."},
        {"name": "alerts", "description": "Prioritised alert queue."},
        {"name": "permits", "description": "Deterministic permit interlocks."},
        {"name": "compliance", "description": "RAG-grounded regulatory answers."},
        {"name": "workflow", "description": "Multi-agent safety workflow."},
        {"name": "evaluation", "description": "Baseline-vs-compound evidence."},
    ],
)

# Dev origins for the operator console. Vite's default is 5173; this project's
# console runs on 8080. Override with SENTINEL_CORS_ORIGINS (comma-separated).
_DEFAULT_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:8080", "http://127.0.0.1:8080",
    "http://localhost:3000", "http://127.0.0.1:3000",
]
_origins = [
    o.strip() for o in os.environ.get("SENTINEL_CORS_ORIGINS", "").split(",") if o.strip()
] or _DEFAULT_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api/v1")


def _require_ready() -> None:
    if not plant.ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=plant.error or "service starting",
        )


# ------------------------------------------------------------------- system
@api.get("/health", response_model=S.HealthResponse, tags=["system"])
def health() -> S.HealthResponse:
    return S.HealthResponse(
        status="ok" if plant.ready else "degraded",
        version=__version__,
        model_loaded=plant.model is not None,
        llm_backend=get_llm().backend,
        regulation_chunks=len(plant.store.chunks) if plant.store else 0,
    )


@api.get("/gemma/status", response_model=S.GemmaStatus, tags=["system"])
def gemma_status() -> S.GemmaStatus:
    """Which Gemma model the agent layer will use, and whether it is reachable.

    Resolved from Ollama's tag list rather than by generating, so the console can
    populate its model badge on page load without spending a generation. That
    matters here: a 4B model on CPU takes seconds per call, and a status badge is
    not worth one.
    """
    from sentinel.agents.tools import REGISTRY
    from sentinel.llm.gemma import get_gemma

    g = get_gemma()
    d = g.describe()
    return S.GemmaStatus(
        model=d["model"],
        runtime=d["runtime"],
        available=d["available"],
        # Stated plainly because it shapes the whole architecture: Ollama has no
        # tool-calling template for Gemma 3, so the model proposes actions as
        # schema-constrained JSON and the deterministic gate executes them.
        native_tool_calling=False,
        tools=sorted(REGISTRY),
        prose_backend=get_llm().backend,
        prose_detail=get_llm().detail,
    )


@api.get("/orchestrator/state", response_model=S.OrchestratorState, tags=["workflow"])
def orchestrator_state() -> S.OrchestratorState:
    """One frame of the autonomous orchestrator: what it sees and what it is doing.

    Deliberately a single read. The console polls this a few times a second to
    animate the chain, and splitting it across endpoints would let the sensor row
    and the node states come from different instants -- so the diagram would show
    a node running for a zone the sensor row had already stopped flagging.
    """
    from sentinel.agents.supervisor import ORCHESTRATOR

    zones = plant.zone_states() if plant.ready else []
    snap = ORCHESTRATOR.snapshot(zones, plant.minute)

    # The in-flight run carries no result: a partial graph state is not a workflow
    # response. The last finished run carries one, and is reported separately so
    # the outcome panels stay populated while the next chain executes.
    current = S.OrchestratorRun(**snap["current"]) if snap["current"] else None
    last = None
    if snap["last_completed"]:
        payload = (
            _workflow_response(snap["last_completed"]["zone_id"], snap["last_result"])
            if snap["last_result"] is not None else None
        )
        last = S.OrchestratorRun(**snap["last_completed"], result=payload)

    return S.OrchestratorState(
        enabled=snap["enabled"], busy=snap["busy"], minute=snap["minute"],
        cycles=snap["cycles"], dispatched=snap["dispatched"],
        idle_reason=snap["idle_reason"],
        dispatch_threshold=snap["dispatch_threshold"],
        sensors=[S.SensorAgent(**s) for s in snap["sensors"]],
        current=current,
        last_completed=last,
        history=[S.OrchestratorHistoryItem(**h) for h in snap["history"]],
        chain=[S.ChainNode(**n) for n in snap["chain"]],
    )


@api.post("/orchestrator/enable", response_model=S.OrchestratorState, tags=["workflow"])
def orchestrator_enable(on: bool = Query(True)) -> S.OrchestratorState:
    """Pause or resume autonomous dispatch.

    Pausing stops new dispatches; a run already in flight finishes. Useful when
    presenting, so the loop does not start a fresh three-minute chain in the
    middle of an explanation of the last one.
    """
    from sentinel.agents.supervisor import ORCHESTRATOR
    ORCHESTRATOR.enabled = on
    return orchestrator_state()


# -------------------------------------------------------------------- plant
@api.get("/zones", response_model=list[S.ZoneState], tags=["plant"])
def zones() -> list[S.ZoneState]:
    _require_ready()
    return [S.ZoneState(**z) for z in plant.zone_states()]


@api.get("/zones/{zone_id}", response_model=S.ZoneState, tags=["plant"])
def zone(zone_id: str) -> S.ZoneState:
    _require_ready()
    try:
        return S.ZoneState(**plant.zone_state(zone_id))
    except KeyError:
        raise HTTPException(404, f"unknown zone '{zone_id}'")


@api.get("/zones/{zone_id}/history", response_model=list[S.ZoneReading], tags=["plant"])
def zone_history(zone_id: str,
                 window: int = Query(90, ge=10, le=240)) -> list[S.ZoneReading]:
    _require_ready()
    try:
        return [S.ZoneReading(**r) for r in plant.zone_history(zone_id, window)]
    except KeyError:
        raise HTTPException(404, f"unknown zone '{zone_id}'")


@api.get("/vision", response_model=S.VisionResponse, tags=["plant"])
def vision() -> S.VisionResponse:
    """Detector-derived occupancy, with imagery provenance.

    Never fails when the CV stack is absent -- it reports `active: false` and the
    reason, and the rest of the system runs on simulated occupancy.
    """
    _require_ready()
    return S.VisionResponse(**plant.vision_report())


@api.get("/site/geo", response_model=S.SiteGeoResponse, tags=["plant"])
def site_geo() -> S.SiteGeoResponse:
    """Real site boundary (OpenStreetMap, ODbL) with explicit provenance."""
    _require_ready()
    return S.SiteGeoResponse(**plant.site_geo())


@api.get("/zones/{zone_id}/proximity", response_model=list[S.ProximateHazardOut],
         tags=["plant"])
def zone_proximity(zone_id: str,
                   radius_m: float = Query(PROXIMITY_RADIUS_M, ge=50, le=8000)
                   ) -> list[S.ProximateHazardOut]:
    """Neighbouring zones with elevated gas within `radius_m` real metres."""
    _require_ready()
    try:
        return [S.ProximateHazardOut(**h)
                for h in plant.proximate_hazards(zone_id, radius_m=radius_m)]
    except KeyError:
        raise HTTPException(404, f"unknown zone '{zone_id}'")


@api.post("/clock/tick", response_model=S.ClockResponse, tags=["plant"])
def tick(steps: int = Query(1, ge=1, le=60)) -> S.ClockResponse:
    """Skip forward. The clock keeps advancing on its own from where it lands."""
    _require_ready()
    plant.tick(steps)
    return S.ClockResponse(**plant.clock_state())


@api.post("/clock/set", response_model=S.ClockResponse, tags=["plant"])
def set_clock(minute: int = Query(..., ge=0, le=239)) -> S.ClockResponse:
    """Seek to a minute. The clock keeps advancing on its own from there."""
    _require_ready()
    plant.set_minute(minute)
    return S.ClockResponse(**plant.clock_state())


@api.get("/clock", response_model=S.ClockResponse, tags=["plant"])
def clock() -> S.ClockResponse:
    return S.ClockResponse(**plant.clock_state())


# ------------------------------------------------------------------- alerts
@api.get("/alerts", response_model=list[S.AlertItem], tags=["alerts"])
def alerts() -> list[S.AlertItem]:
    _require_ready()
    return [S.AlertItem(**a) for a in plant.alerts()]


@api.get("/alerts/log", response_model=list[S.AlertLogEntry], tags=["alerts"])
def alert_log(limit: int = Query(200, ge=1, le=1000),
              zone_id: str | None = Query(None, description="Filter to one zone")
              ) -> list[S.AlertLogEntry]:
    """Append-only history of alert transitions, newest first.

    `/alerts` is a view of the current plant minute only, so an alert that rose
    and cleared between two polls left no trace. This is the record: every
    RAISED / ESCALATED / DE-ESCALATED / CLEARED transition, written once per
    plant minute by the clock rather than on request, so the history is the same
    whether or not anybody was watching.
    """
    _require_ready()
    return [S.AlertLogEntry(**e) for e in plant.alert_log_entries(limit, zone_id)]


# ------------------------------------------------------------------ permits
@api.post("/permits/evaluate", response_model=S.PermitDecisionResponse, tags=["permits"])
def evaluate(body: S.PermitRequestBody) -> S.PermitDecisionResponse:
    """Deterministic interlocks, optionally escalated by the compound-risk model.

    This endpoint does not require the LLM and stays available if it is down.
    """
    _require_ready()
    try:
        s = plant.zone_state(body.zone_id)
    except KeyError:
        raise HTTPException(404, f"unknown zone '{body.zone_id}'")

    cond = ZoneConditions(
        gas_lel=s["gas_lel"], gas_trend=s["gas_trend"],
        maintenance_active=s["maintenance_active"],
        workers_in_zone=s["workers_in_zone"],
        # Left as None deliberately: no zone in this plant has an O2 instrument
        # bound to it, and asserting 20.9% would make every confined-space
        # oxygen check pass on a measurement that was never taken.
        o2_pct=None,
        uncovered_heads=s["uncovered_heads"],
        ppe_verified=s["ppe_verified"],
        # Spatial context: units venting nearby make an otherwise-clean permit
        # a simultaneous-operations problem.
        proximate_hazards=[
            ProximateHazard(zone_id=h["zone_id"], distance_m=h["distance_m"],
                            gas_lel=h["gas_lel"], rising=h["rising"])
            for h in plant.proximate_hazards(body.zone_id)
        ],
    )
    decision = evaluate_permit(
        PermitRequest(body.permit_type, zone=body.zone_id, machine_id=body.machine_id),
        cond,
        compound_risk=s["risk"] if body.use_ai_risk else None,
        lead_time_min=s["lead_time_min"] if body.use_ai_risk else None,
    )
    return S.PermitDecisionResponse(**decision.as_dict())


# --------------------------------------------------------------- compliance
_PROV_OFFICIAL = {"STATUTE", "OFFICIAL"}


@api.post("/compliance/ask", response_model=S.ComplianceResponse, tags=["compliance"])
def ask(body: S.ComplianceQuery) -> S.ComplianceResponse:
    _require_ready()
    from sentinel.rag.assistant import ComplianceAssistant
    ans = ComplianceAssistant(store=plant.store).ask(body.question, k=body.top_k)
    return S.ComplianceResponse(
        question=ans.question, answer=ans.answer, backend=ans.backend,
        grounded=ans.grounded, confidence=ans.confidence,
        citations=[S.Citation(
            standard=c.standard, section=c.section, provenance=c.provenance,
            is_official=c.provenance in _PROV_OFFICIAL, score=round(c.score, 4),
            kind=c.kind,
        ) for c in ans.chunks],
    )


# ----------------------------------------------------------------- workflow
def _execute_workflow(zone_id: str) -> dict:
    """Run the agent chain against a zone's live state and return raw graph output.

    Shared by the workflow endpoint and the autonomous orchestrator so both build
    the graph's input from the same place. Duplicating this mapping is how the two
    paths drift: the orchestrator would keep analysing zones on a state the
    endpoint had already stopped sending.
    """
    s = plant.zone_state(zone_id)                 # KeyError propagates to caller
    from sentinel.agents.graph import run_safety_workflow
    drivers = "; ".join(d["label"] for d in s["drivers"][:4]) or "n/a"
    return run_safety_workflow({
        "zone": s["name"], "machine_id": zone_id, "risk": s["risk"],
        # Pass None through as None. Coercing it to 0 made every zone without a
        # horizon prediction report "~0 min to threshold", which reads as "the
        # incident is happening now" on a zone at 4% risk.
        "lead_time_min": s["lead_time_min"],
        "anomaly_score": s["anomaly_score"], "explanation": drivers,
        "gas_lel": s["gas_lel"], "gas_trend": s["gas_trend"],
        "o2_pct": None,                       # not instrumented -- see /permits/evaluate
        "maintenance_active": s["maintenance_active"],
        "hot_work_active": s["hot_work_active"],
        "workers_in_zone": s["workers_in_zone"],
        "night_shift": s["night_shift"], "in_changeover": s["in_changeover"],
        "area_class": s["area_class"],
        "uncovered_heads": s["uncovered_heads"],
        "ppe_verified": s["ppe_verified"],
        "proximate_hazards": plant.proximate_hazards(zone_id),
    })


@api.post("/workflow/run/{zone_id}", response_model=S.WorkflowResponse, tags=["workflow"])
def run_workflow(zone_id: str) -> S.WorkflowResponse:
    """Execute the multi-agent safety workflow against a zone's live state."""
    _require_ready()
    try:
        result = _execute_workflow(zone_id)
    except KeyError:
        raise HTTPException(404, f"unknown zone '{zone_id}'")
    return _workflow_response(zone_id, result)


def _workflow_response(zone_id: str, result: dict) -> S.WorkflowResponse:
    """Shape raw graph output into the API response."""
    comp = result.get("compliance")
    comp_model = None
    if comp:
        # Citations were previously dropped here, so the console showed a wall
        # of unattributed text while the trace claimed four sources. The whole
        # point of the RAG layer is that the answer is attributable.
        comp_model = S.ComplianceResponse(
            question=comp.get("question", ""), answer=comp.get("answer", ""),
            backend=comp.get("backend", "none"), grounded=comp.get("grounded", False),
            confidence=comp.get("confidence", "high"),
            citations=[
                S.Citation(
                    standard=c["standard"], section=c["section"],
                    provenance=c["provenance"],
                    is_official=c["provenance"] in _PROV_OFFICIAL,
                    score=round(c["score"], 4),
                    kind=c.get("kind", "REGULATION"),
                )
                for c in comp.get("chunks", [])
            ],
        )
    pdec = result.get("permit_decision")
    plan = result.get("gemma_plan") or {}
    refl = result.get("gemma_reflection")
    brief = result.get("gemma_briefing")
    # Confidence is surfaced but explicitly not acted on: a 4B model reporting
    # 0.95 on a zone the rule engine cleared is not evidence of anything, and the
    # gate in sentinel.agents.tools ignores it by design. Showing it lets an
    # operator see the gap between what the agent believed and what it was
    # allowed to do.
    conf = plan.get("confidence")
    return S.WorkflowResponse(
        zone_id=zone_id,
        trace=result.get("trace", []),
        priority=(result.get("priority") or {}).get("priority"),
        permit_decision=S.PermitDecisionResponse(**pdec) if pdec else None,
        interlocks=result.get("interlocks", []),
        compliance=comp_model,
        actions=result.get("actions", []),
        report=result.get("report"),
        tool_executions=[S.ToolReceipt(**r) for r in (result.get("tool_executions") or [])],
        gemma_reasoning=(plan.get("reasoning") or None),
        gemma_confidence=float(conf) if isinstance(conf, (int, float)) else None,
        gemma_reflection=S.GemmaReflection(**refl) if refl else None,
        gemma_briefing=S.GemmaBriefing(**brief) if brief else None,
        gemma_meta=[S.GemmaNodeMeta(**m) for m in (result.get("gemma_meta") or [])],
    )


# ---------------------------------------------------------------- simulation
@api.post("/simulate", response_model=list[S.SimulationResult], tags=["plant"])
def simulate_all(body: S.SimulationRequest) -> list[S.SimulationResult]:
    """Re-score every zone under what-if overrides, using the trained forecaster.

    The counterfactual runs through the same feature pipeline and the same
    LightGBM model as live scoring, so the number an operator sees here is the
    model's actual opinion rather than a proxy formula.
    """
    _require_ready()
    return [S.SimulationResult(**r) for r in plant.simulate_all(**body.model_dump())]


@api.post("/simulate/{zone_id}", response_model=S.SimulationResult, tags=["plant"])
def simulate_zone(zone_id: str, body: S.SimulationRequest) -> S.SimulationResult:
    _require_ready()
    try:
        return S.SimulationResult(**plant.simulate(zone_id, **body.model_dump()))
    except KeyError:
        raise HTTPException(404, f"unknown zone '{zone_id}'")


# ---------------------------------------------------------------- evaluation
@api.get("/evaluation/scoreboard", response_model=S.ScoreboardResponse, tags=["evaluation"])
def scoreboard() -> S.ScoreboardResponse:
    """The baseline-vs-compound evidence produced by scripts/run_pipeline.py."""
    path = ROOT / "reports" / "scoreboard.json"
    legacy = ROOT / "reports" / "row_metrics.json"
    if not path.exists():
        raise HTTPException(
            404, "no scoreboard.json -- run scripts/run_pipeline.py to generate it"
            + (" (row_metrics.json found, but it is a different report)" if legacy.exists() else "")
        )
    return S.ScoreboardResponse(**json.loads(path.read_text()))


app.include_router(api)


@app.exception_handler(HTTPException)
async def problem_detail(request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"type": f"https://sentinel.ai/errors/{exc.status_code}",
                 "title": exc.detail, "status": exc.status_code,
                 "instance": str(request.url.path)},
    )


@app.get("/", include_in_schema=False)
def root() -> dict:
    return {"service": "Sentinel-Gemma", "version": __version__, "docs": "/docs"}
