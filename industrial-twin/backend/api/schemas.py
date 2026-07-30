"""Pydantic v2 request/response models.

Every field is typed, bounded and documented so the generated OpenAPI contract is
usable as the integration spec for a plant IT team -- not just a debug page.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

PermitType = Literal["Hot Work", "Confined Space", "Cold Work", "Electrical"]
PermitStatus = Literal["APPROVED", "CONDITIONAL", "REJECTED"]
Priority = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    model_loaded: bool
    llm_backend: str = Field(description="gemini | ollama | extractive")
    regulation_chunks: int


class ProximateHazardOut(BaseModel):
    """A neighbouring zone with elevated gas, at a real distance in metres."""
    zone_id: str
    name: str
    distance_m: int = Field(ge=0, description="Great-circle distance, metres")
    gas_lel: float
    gas_trend: float
    rising: bool
    area_class: str


class ZoneOccupancyOut(BaseModel):
    zone_id: str
    frame: str = Field(description="Source image analysed for this zone")
    detected: int = Field(ge=0)
    confidences: list[float]
    inference_ms: float
    # Present only when the fine-tuned PPE model is loaded.
    heads: int | None = None
    helmets: int | None = None
    uncovered_heads: int | None = Field(
        default=None, description="heads - helmets; the compliance gap")
    vests: int | None = None
    ppe_violation: bool = False
    ppe_verified: bool = Field(
        default=True,
        description="False when the helmet class never fired across any frame, so "
                    "'uncovered heads' cannot be read as a compliance finding")


class VisionResponse(BaseModel):
    """Detector output with explicit provenance.

    The imagery, the model and the inference are real. Which frame is bound to
    which zone is representative -- there is no live camera -- and
    `frame_binding` says so rather than implying one.
    """
    enabled: bool = Field(description="SENTINEL_VISION set?")
    active: bool = Field(description="Did the detector actually produce counts?")
    detector: dict
    frame_source: str
    frame_licence: str
    attribution: str
    frame_binding: Literal["representative", "live"]
    frames_available: int
    ppe_verified: bool = Field(
        default=True,
        description="Site-level PPE verdict quality. False means the helmet class "
                    "is not firing, so per-zone violations are not evidence.")
    zones: list[ZoneOccupancyOut]


class SiteGeoResponse(BaseModel):
    """Site boundary and its provenance, for the geospatial layer.

    The boundary is real, externally-sourced open data. Internal unit placement
    is representative, and `zone_placement` says so rather than implying survey
    accuracy the project does not have.
    """
    site_name: str
    osm_way_id: int = Field(description="OpenStreetMap way ID of the site boundary")
    attribution: str
    boundary: list[list[float]] = Field(description="[[lon, lat], ...] ring")
    zone_placement: Literal["representative", "surveyed"]
    proximity_radius_m: float


class ClockResponse(BaseModel):
    """State of the shared plant clock.

    The API advances this on its own from startup, so every connected client
    sees the same continuously running plant without driving it.
    """
    model_config = ConfigDict(json_schema_extra={"example": {
        "minute": 60, "episode_minutes": 240, "laps": 0,
        "running": True, "seconds_per_minute": 1.0,
    }})

    minute: int = Field(ge=0, description="Current minute within the episode")
    episode_minutes: int = Field(gt=0, description="Episode length; the clock wraps here")
    laps: int = Field(ge=0, description="Completed replays since startup")
    running: bool = Field(description="Is the server-side clock advancing?")
    seconds_per_minute: float = Field(gt=0, description="Wall-clock seconds per plant minute")


class ZoneReading(BaseModel):
    """A single point in a zone's live telemetry."""
    model_config = ConfigDict(json_schema_extra={"example": {
        "minute": 58, "gas_lel": 4.5, "pressure": 8.4,
        "temperature": 57.2, "vibration": 1.8, "risk": 0.96,
    }})

    minute: int = Field(ge=0, description="Minutes since episode start")
    gas_lel: float = Field(ge=0, description="Point-sensor combustible gas, % LEL")
    pressure: float = Field(description="Line pressure, bar")
    temperature: float = Field(description="Zone temperature, degrees C")
    vibration: float = Field(ge=0, description="Equipment vibration index")
    risk: float = Field(ge=0, le=1, description="P(incident within forecast horizon)")


class ShapDriver(BaseModel):
    feature: str
    label: str = Field(description="Human-readable feature name")
    contribution: float = Field(description="Signed SHAP value; >0 increases risk")


class ZoneState(BaseModel):
    """Everything the dashboard needs to render one zone."""
    zone_id: str
    name: str
    x: float = Field(description="Floor-plan X coordinate (0-100)")
    y: float = Field(description="Floor-plan Y coordinate (0-100)")
    lat: float = Field(description="WGS84 latitude, inside the real RINL site boundary")
    lon: float = Field(description="WGS84 longitude")
    area_class: Literal["ZONE_0", "ZONE_1", "ZONE_2", "SAFE"] = Field(
        description="IEC 60079-10-1 hazardous area classification")
    on_site: bool = Field(
        description="Point-in-polygon against the real OSM site boundary")
    workers_detected: int | None = Field(
        default=None,
        description="People counted by the detector; null when vision is off")
    worker_source: Literal["simulated", "cv", "cv+floor"] = Field(
        default="simulated",
        description="Origin of workers_in_zone. 'cv+floor' means the detector "
                    "counted fewer than the floor, so the floor was kept -- "
                    "detection may raise occupancy, never lower it")
    uncovered_heads: int = Field(
        default=0, ge=0,
        description="Heads detected without a helmet. Consequence, not hazard: it "
                    "raises alert priority and can downgrade a permit, but it is "
                    "deliberately NOT an input to `risk`")
    ppe_verified: bool = Field(
        default=True,
        description="False when the detector could not judge PPE at all")
    risk: float = Field(ge=0, le=1)
    risk_band: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    gas_lel: float
    gas_trend: float = Field(description="% LEL per minute; >0 is rising")
    pressure: float
    temperature: float
    anomaly_score: float
    workers_in_zone: int = Field(ge=0)
    maintenance_active: bool
    hot_work_active: bool
    night_shift: bool
    in_changeover: bool
    lead_time_min: int | None = Field(
        default=None, description="Predicted minutes to threshold crossing")
    baseline_alarm: bool = Field(
        description="Would a conventional single-sensor alarm be firing right now?")
    drivers: list[ShapDriver] = Field(default_factory=list)


class AlertItem(BaseModel):
    alert_id: str
    zone_id: str
    zone_name: str
    priority: Priority
    score: float
    risk: float
    lead_time_min: int | None = None
    drivers: list[str] = Field(default_factory=list)
    raised_at: datetime


class AlertLogEntry(BaseModel):
    """One transition in the alert history.

    The live queue only ever describes the current plant minute. This is the
    record of what happened, so an alert that rose and cleared unattended is
    still reviewable afterwards.
    """
    seq: int = Field(description="Monotonic sequence number since startup")
    event: Literal["RAISED", "ESCALATED", "DE-ESCALATED", "CLEARED"]
    alert_id: str
    zone_id: str
    zone_name: str
    priority: Priority
    risk: float = Field(ge=0, le=1)
    score: float
    lead_time_min: int | None = None
    drivers: list[str] = Field(default_factory=list)
    minute: int = Field(ge=0, description="Plant minute the transition occurred at")
    lap: int = Field(ge=0, description="Which replay of the episode")
    note: str = Field(default="", description="Priority change or duration held open")
    at: datetime


class PermitDecisionResponse(BaseModel):
    status: PermitStatus
    reasons: list[str]
    citations: list[str]
    checks: list[str] = Field(
        default_factory=list,
        description="Every interlock evaluated, with the readings it was evaluated "
                    "on -- the audit trail behind the verdict, including for an "
                    "APPROVED permit")


class PermitRequestBody(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {
        "permit_type": "Hot Work", "zone_id": "COB-B",
        "machine_id": "COB-B-07", "use_ai_risk": True,
    }})

    permit_type: PermitType
    zone_id: str
    machine_id: str = ""
    use_ai_risk: bool = Field(
        default=True,
        description="Allow the compound-risk model to escalate the decision. "
                    "It can only make the outcome stricter, never more permissive.")


class ComplianceQuery(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {
        "question": "Can hot work continue if gas readings are rising?"}})
    question: str = Field(min_length=5, max_length=500)
    top_k: int = Field(default=4, ge=1, le=10)


class Citation(BaseModel):
    standard: str
    section: str
    provenance: Literal["STATUTE", "OFFICIAL", "SUMMARY", "REFERENCE_ONLY"]
    is_official: bool
    score: float
    kind: Literal["REGULATION", "INTERNAL"] = Field(
        default="REGULATION",
        description="INTERNAL means this plant's own SOP, not a standard or statute. "
                    "An answer resting only on INTERNAL sources is not regulatory "
                    "grounding.")


class ComplianceResponse(BaseModel):
    question: str
    answer: str
    citations: list[Citation]
    backend: str
    grounded: bool = Field(
        description="True only when a regulatory passage matched confidently. False "
                    "means the answer rests on weak matches or on this plant's own "
                    "SOP, and should not be read as regulatory grounding.")
    confidence: Literal["none", "low", "high"] = Field(
        default="high",
        description="none = nothing cleared the retrieval floor and no answer was "
                    "attempted; low = retrieved, but weakly or only from the internal "
                    "SOP; high = a standard matched confidently.")


class WorkflowResponse(BaseModel):
    zone_id: str
    trace: list[str] = Field(description="Ordered agent execution trace")
    priority: Priority | None = None
    permit_decision: PermitDecisionResponse | None = None
    interlocks: list[str] = Field(default_factory=list)
    compliance: ComplianceResponse | None = None
    actions: list[str] = Field(default_factory=list)
    report: str | None = Field(default=None, description="Draft regulatory notification")


class SimulationRequest(BaseModel):
    """Operator what-if. Deltas are applied to the zone's live sensor channels.

    Only channels the forecaster actually consumes are exposed. Worker count is
    deliberately absent: it drives alert priority, not the hazard model.
    """
    model_config = ConfigDict(json_schema_extra={"example": {
        "gas_delta": 4.0, "hot_work": True, "maintenance": True,
    }})

    gas_delta: float = Field(default=0.0, ge=-50, le=50, description="% LEL offset")
    pressure_delta: float = Field(default=0.0, ge=-10, le=10, description="bar offset")
    temperature_delta: float = Field(default=0.0, ge=-60, le=60, description="deg C offset")
    hot_work: bool | None = Field(default=None, description="Override the hot-work permit flag")
    maintenance: bool | None = Field(default=None, description="Override the maintenance flag")


class SimulationResult(BaseModel):
    zone_id: str
    name: str
    minute: int
    baseline_risk: float = Field(ge=0, le=1, description="The zone's unmodified risk")
    simulated_risk: float = Field(ge=0, le=1, description="Risk under the overrides")
    risk_band: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    gas_lel: float
    pressure: float
    temperature: float
    hot_work_active: bool
    maintenance_active: bool
    baseline_alarm: bool
    drivers: list[ShapDriver] = Field(default_factory=list)


class ScoreboardResponse(BaseModel):
    """Baseline vs compound engine -- the evaluation evidence."""
    n_episodes: int
    n_incident_episodes: int
    n_safe_episodes: int
    baseline_detection_rate: float
    compound_detection_rate: float
    baseline_false_negative_rate: float
    compound_false_negative_rate: float
    baseline_false_alarm_rate: float
    compound_false_alarm_rate: float
    matched_baseline_lead_min: float | None = None
    matched_compound_lead_min: float | None = None
    incidents_missed_by_baseline_caught_by_compound: int
