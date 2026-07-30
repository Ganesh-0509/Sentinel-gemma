/**
 * TypeScript mirrors of the backend's Pydantic response models
 * (`backend/api/schemas.py`). Keep these in sync with that file — it is the
 * source of truth. The generated OpenAPI contract lives at /docs.
 */

export type PermitType = "Hot Work" | "Confined Space" | "Cold Work" | "Electrical";
export type PermitStatus = "APPROVED" | "CONDITIONAL" | "REJECTED";
export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type RiskBand = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Provenance = "STATUTE" | "OFFICIAL" | "SUMMARY" | "REFERENCE_ONLY";

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  model_loaded: boolean;
  llm_backend: string;
  regulation_chunks: number;
}

export interface ShapDriver {
  feature: string;
  label: string;
  /** Signed SHAP value; > 0 increases risk. */
  contribution: number;
}

/** IEC 60079-10-1 explosive-atmosphere zone classification. */
export type HazardousAreaClass = "ZONE_0" | "ZONE_1" | "ZONE_2" | "SAFE";

/** Where a zone's occupancy figure came from. */
export type WorkerSource = "simulated" | "cv" | "cv+floor";

export interface ZoneOccupancy {
  zone_id: string;
  frame: string;
  detected: number;
  confidences: number[];
  inference_ms: number;
  /** PPE fields are present only when the fine-tuned model is loaded. */
  heads: number | null;
  helmets: number | null;
  /** heads − helmets: the compliance gap. */
  uncovered_heads: number | null;
  vests: number | null;
  ppe_violation: boolean;
  /**
   * False when the helmet class never fired across any frame, so
   * `uncovered_heads` cannot be read as a compliance finding.
   */
  ppe_verified: boolean;
}

/**
 * Detector output plus provenance. The imagery, model and inference are real;
 * the frame-to-zone binding is representative, and `frame_binding` says so.
 */
export interface VisionResponse {
  enabled: boolean;
  active: boolean;
  detector: {
    available: boolean;
    weights: string | null;
    min_confidence: number;
    matplotlib_stubbed: boolean;
    error: string | null;
  };
  frame_source: string;
  frame_licence: string;
  attribution: string;
  frame_binding: "representative" | "live";
  frames_available: number;
  /** Site-level verdict quality; false means per-zone violations are not evidence. */
  ppe_verified: boolean;
  zones: ZoneOccupancy[];
}

/** A neighbouring zone venting within a real distance in metres. */
export interface ProximateHazard {
  zone_id: string;
  name: string;
  distance_m: number;
  gas_lel: number;
  gas_trend: number;
  rising: boolean;
  area_class: HazardousAreaClass;
}

/**
 * Site boundary and its provenance. The boundary is real open data; internal
 * unit placement is representative, and `zone_placement` says which.
 */
export interface SiteGeoResponse {
  site_name: string;
  osm_way_id: number;
  attribution: string;
  /** [[lon, lat], ...] ring. */
  boundary: [number, number][];
  zone_placement: "representative" | "surveyed";
  proximity_radius_m: number;
}

export interface ZoneState {
  zone_id: string;
  name: string;
  /** Floor-plan coordinates on a 0-100 grid, for 2D rendering. */
  x: number;
  y: number;
  /**
   * WGS84 coordinates inside the real RINL site boundary (OSM way 395219953).
   * Unit placement is representative, not surveyed — see /site/geo.
   */
  lat: number;
  lon: number;
  /** IEC 60079-10-1 hazardous area classification. */
  area_class: HazardousAreaClass;
  /** Point-in-polygon against the real site boundary. */
  on_site: boolean;
  /** People counted by the detector; null when vision is off. */
  workers_detected: number | null;
  /**
   * Origin of `workers_in_zone`. `"cv+floor"` means the detector counted fewer
   * than the simulated floor, so the floor was kept — detection may raise
   * occupancy, never lower it.
   */
  worker_source: WorkerSource;
  /**
   * Heads detected without a helmet. Consequence, not hazard: it raises alert
   * priority and can downgrade a permit, but it is deliberately NOT an input to
   * `risk` — which is why a zone can show a PPE violation at low risk, or clean
   * PPE at high risk. The two answer different questions.
   */
  uncovered_heads: number;
  /** False when the detector could not judge PPE at all. */
  ppe_verified: boolean;
  /** P(incident within the forecast horizon), 0-1. */
  risk: number;
  risk_band: RiskBand;
  gas_lel: number;
  /** % LEL per minute; > 0 is rising. */
  gas_trend: number;
  pressure: number;
  temperature: number;
  anomaly_score: number;
  workers_in_zone: number;
  maintenance_active: boolean;
  hot_work_active: boolean;
  night_shift: boolean;
  in_changeover: boolean;
  lead_time_min: number | null;
  /** Would a conventional single-sensor alarm be firing right now? */
  baseline_alarm: boolean;
  drivers: ShapDriver[];
}

export interface ZoneReading {
  minute: number;
  gas_lel: number;
  pressure: number;
  temperature: number;
  vibration: number;
  risk: number;
}

export interface AlertItem {
  alert_id: string;
  zone_id: string;
  zone_name: string;
  priority: Priority;
  score: number;
  risk: number;
  lead_time_min: number | null;
  drivers: string[];
  raised_at: string;
}

/** One transition in the alert history. */
export type AlertEvent = "RAISED" | "ESCALATED" | "DE-ESCALATED" | "CLEARED";

export interface AlertLogEntry {
  seq: number;
  event: AlertEvent;
  alert_id: string;
  zone_id: string;
  zone_name: string;
  priority: Priority;
  risk: number;
  score: number;
  lead_time_min: number | null;
  drivers: string[];
  /** Plant minute the transition occurred at. */
  minute: number;
  /** Which replay of the episode. */
  lap: number;
  /** Priority change, or how long the alert was held open. */
  note: string;
  at: string;
}

export interface PermitDecisionResponse {
  status: PermitStatus;
  reasons: string[];
  citations: string[];
  /**
   * Every interlock evaluated, with the readings it was evaluated on — the
   * audit trail behind the verdict, present even for an APPROVED permit.
   */
  checks: string[];
}

export interface PermitRequestBody {
  permit_type: PermitType;
  zone_id: string;
  machine_id?: string;
  /** The model may only make the outcome stricter, never more permissive. */
  use_ai_risk?: boolean;
}

/** Where a cited passage comes from. */
export type SourceKind = "REGULATION" | "INTERNAL";

/**
 * How well the corpus actually covered the question.
 * `none` — nothing cleared the retrieval floor; no answer was attempted.
 * `low`  — retrieved, but weakly, or only from this plant's own SOP.
 * `high` — a standard or statute matched confidently.
 */
export type Confidence = "none" | "low" | "high";

export interface Citation {
  standard: string;
  section: string;
  provenance: Provenance;
  is_official: boolean;
  score: number;
  /** INTERNAL means our own SOP — not regulatory grounding. */
  kind: SourceKind;
}

export interface ComplianceResponse {
  question: string;
  answer: string;
  citations: Citation[];
  backend: string;
  /**
   * True only when a regulatory passage matched confidently. False means the
   * answer rests on weak matches or on our own SOP — not regulatory grounding.
   */
  grounded: boolean;
  confidence: Confidence;
}

/**
 * One containment action Gemma proposed.
 *
 * `executed: false` is a normal, expected outcome, not an error. The gate in
 * backend/agents/tools.py refuses any restrictive action the deterministic layer
 * has not justified, and those refusals are rendered beside the executions —
 * they are the visible proof that the model is not trusted blindly.
 */
export interface ToolReceipt {
  tool: string;
  executed: boolean;
  /** Arguments exactly as the model returned them, before coercion. */
  proposed: Record<string, unknown>;
  /** Arguments after coercion to the real tool signature. Null when refused. */
  arguments: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  refused_because: string | null;
  elapsed_ms: number;
}

/** Per-node model telemetry. `gen_ms` excludes model load; see gemma.py. */
export interface GemmaNodeMeta {
  node: string;
  model: string;
  runtime: string;
  latency_ms: number;
  load_ms: number;
  gen_ms: number;
  eval_count: number;
  prompt_count: number;
  tokens_per_s: number;
  truncated: boolean;
}

/** SHAP attributions rendered for a shift in-charge. */
export interface GemmaBriefing {
  headline: string;
  why_now: string;
  watch: string;
}

/** The agent's review of its own refused proposals. */
export interface GemmaReflection {
  /**
   * The model believes a refusal reason misstates the readings. Rendered only
   * when true: asked to confirm agreement instead, it returned the wrong boolean
   * beside prose that agreed with the gate, so the field flags an exception
   * rather than labelling every run. The refusal stands either way.
   */
  disputes_refusal: boolean;
  correction: string;
  residual_risk: string;
}

export interface GemmaStatus {
  model: string;
  runtime: string;
  available: boolean;
  /**
   * False for Gemma 3 on Ollama, which has no tool-calling template. Actions are
   * proposed as schema-constrained JSON and executed by the deterministic gate.
   */
  native_tool_calling: boolean;
  tools: string[];
  prose_backend: string;
  prose_detail: string;
}

export interface WorkflowResponse {
  zone_id: string;
  trace: string[];
  priority: Priority | null;
  permit_decision: PermitDecisionResponse | null;
  interlocks: string[];
  compliance: ComplianceResponse | null;
  actions: string[];
  report: string | null;
  tool_executions: ToolReceipt[];
  gemma_reasoning: string | null;
  /**
   * The model's self-reported confidence. Displayed for transparency only — the
   * safety gate ignores it by design, so a high value next to a refused action
   * is informative rather than contradictory.
   */
  gemma_confidence: number | null;
  gemma_reflection: GemmaReflection | null;
  gemma_briefing: GemmaBriefing | null;
  gemma_meta: GemmaNodeMeta[];
}

export interface SimulationRequest {
  /** % LEL offset applied to the zone's gas channel. */
  gas_delta?: number;
  /** bar offset. */
  pressure_delta?: number;
  /** degrees C offset. */
  temperature_delta?: number;
  hot_work?: boolean | null;
  maintenance?: boolean | null;
}

export interface SimulationResult {
  zone_id: string;
  name: string;
  minute: number;
  /** The zone's unmodified risk, for side-by-side comparison. */
  baseline_risk: number;
  /** Risk under the overrides, scored by the same LightGBM forecaster. */
  simulated_risk: number;
  risk_band: RiskBand;
  gas_lel: number;
  pressure: number;
  temperature: number;
  hot_work_active: boolean;
  maintenance_active: boolean;
  baseline_alarm: boolean;
  drivers: ShapDriver[];
}

export interface ScoreboardResponse {
  n_episodes: number;
  n_incident_episodes: number;
  n_safe_episodes: number;
  baseline_detection_rate: number;
  compound_detection_rate: number;
  baseline_false_negative_rate: number;
  compound_false_negative_rate: number;
  baseline_false_alarm_rate: number;
  compound_false_alarm_rate: number;
  matched_baseline_lead_min: number | null;
  matched_compound_lead_min: number | null;
  incidents_missed_by_baseline_caught_by_compound: number;
}

/**
 * The shared plant clock. The backend advances this by itself from startup, so
 * the console is live on arrival and every client sees the same minute.
 */
export interface ClockResponse {
  minute: number;
  /** Episode length; the clock wraps back to 0 here and replays. */
  episode_minutes: number;
  /** Completed replays since the backend started. */
  laps: number;
  running: boolean;
  seconds_per_minute: number;
}
