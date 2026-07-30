# Data Ingestion Pipeline & Model I/O Contract

# SentinelAI
### AI-Powered Industrial Safety Intelligence Platform

**Version:** 1.0
**Purpose:** Exactly how data enters the platform, how it is normalised, **which model consumes
which ingestion stream**, and **what output each model produces**.

---

# 1. Pipeline Overview

SentinelAI never talks to a PLC. It sits *above* existing plant systems and ingests what they
already emit. Every stream passes through the same five stages:

```
  SOURCE            INGEST            NORMALISE          FEATURE STORE        MODELS
  ------            ------            ---------          -------------        ------
  SCADA / IoT  -->  stream adapter -->  unit + time  -->  rolling windows  -->  Baseline
  Permits      -->  REST / CSV     -->  alignment    -->  interactions     -->  Forecaster
  Maintenance  -->  REST / CSV     -->  validation   -->  context flags    -->  Anomaly
  Shift roster -->  batch          -->  dedupe       -->  exposure         -->  Rule Engine
  Layout       -->  static config  -->  geo index    -->  zone mapping     -->  Heatmap
  Regulations  -->  document load  -->  chunk+embed  -->  vector index     -->  RAG
```

**Stage 1 — Ingest.** Protocol adapters (REST push, CSV batch, MQTT/simulated stream, file upload).
**Stage 2 — Validate.** Schema check, range check, duplicate drop, bad-quality flagging.
**Stage 3 — Normalise.** Unit conversion (all combustible gas to **% LEL**), UTC timestamps,
resample to a **1-minute grid**, forward-fill short gaps, mark long gaps as missing.
**Stage 4 — Feature Store.** Rolling statistics, trends, rate-of-change, operational context flags
and **cross-signal interaction terms** — the single source of truth every model reads from.
**Stage 5 — Models.** See the contract table in §3.

> Today the SCADA stream is supplied by `sentinel/sim/simulator.py` (a physics-lite simulator).
> Swapping it for a live MQTT/OPC-UA feed only replaces the Stage-1 adapter — Stages 2–5 are unchanged.
> That is the whole point of the layered design.

---

# 2. Ingestion Modes

| Mode | Used by | Cadence | Notes |
|---|---|---|---|
| **Streaming** (MQTT / REST push / simulator) | Sensor + SCADA tags | 1 min | Real-time path; drives live risk. |
| **Event** (REST `POST`) | Permits, maintenance work orders | On creation/close | State changes, not samples. |
| **Batch** (CSV / scheduled pull) | Shift roster, historical incidents | Daily / one-off | Bulk load + backfill. |
| **Static config** | Plant layout, zone definitions, sensor metadata | On change | Drives geospatial layer. |
| **Document load** | OISD / Factory Act / DGMS / SOPs | One-off + on update | Chunked and embedded into the vector index. |

---

# 3. ⭐ Ingestion → Model → Output Contract

This is the authoritative mapping: **what each model eats and what it emits.**

| # | Ingestion stream | Format in | Model that consumes it | Model output |
|---|---|---|---|---|
| 1 | Gas / pressure / temperature / vibration (SCADA, IoT) | 1-min numeric time series | **Tier 0 — Single-Sensor Baseline** | Boolean alarm per minute + first-alarm time (the control group) |
| 2 | Same stream **+** permit / maintenance / shift context | Engineered feature vector (25 features) | **Tier 1 — Compound Risk Forecaster** (LightGBM) | `P(incident within 15/30/60 min)` → compound risk score + **lead-time estimate** |
| 3 | Same stream, **normal operation only** (no labels) | Engineered feature vector | **Tier 2 — Anomaly Detector** (Isolation Forest + PCA reconstruction) | Anomaly score (robust z, capped) + `is_anomaly` flag — catches unknown-unknowns |
| 4 | Live gas / O₂ readings **+** permit request | `ZoneConditions` + `PermitRequest` objects | **Tier 3 — Deterministic Rule Engine** | `APPROVED` / `CONDITIONAL` / `REJECTED` + human reasons + **regulatory citations** |
| 5 | Trained forecaster + a single feature row | Feature vector | **Tier 4 — SHAP Explainer** | Signed feature attributions → plain-language "why this alert" |
| 6 | OISD-STD-105, Factory Act, DGMS, SOPs | PDF/text → chunks → embeddings | **Tier 5 — RAG Compliance Assistant** (Gemini primary / Ollama fallback) | Grounded answer + **cited clause** |
| 7 | Fused risk + permit + compliance state | Structured state object | **Tier 6 — Agentic Layer** (LangGraph) | Actions: permit decision, escalation, evacuation trigger, multi-channel alert, draft incident report |
| 8 | Plant layout + worker/zone assignment + zone risk | Coordinates + risk per zone | **Geospatial Heatmap** | Zone-level risk overlay + workers-in-danger-zone count |

### 3.1 Fusion rules (how the outputs combine)

1. **Rule Engine has veto.** Hard gas/O₂ interlocks override everything. The AI may **escalate or
   reject**, but can *never approve* work the interlocks rejected — fail-safe by design.
2. **Compound score** = calibrated blend of forecaster probability, anomaly score and spatial
   exposure (workers in zone).
3. **Lead time** = earliest forecast horizon whose probability crosses the decision threshold.
4. **Alert priority** = risk × people-exposed × asset-criticality (this is what de-noises the feed).
5. **SHAP** annotates every alert; **agents** act on the fused state.

---

# 4. Data Contracts (minimum schema per stream)

**Sensor reading** — `timestamp` (UTC), `sensor_id`, `machine_id`, `zone`, `value`, `unit`, `quality`.
**Permit** — `permit_id`, `permit_type` (Hot Work | Confined Space | Cold Work | Electrical),
`zone`, `machine_id`, `start_time`, `end_time`, `status`.
**Maintenance** — `maintenance_id`, `machine_id`, `type` (Preventive|Corrective|Emergency),
`start_time`, `end_time`, `status`.
**Shift / roster** — `shift_id`, `shift_type`, `supervisor`, `worker_count`, `zone`.
**Plant layout** — `machine_id`, `zone`, `x`, `y`, `hazard_class`.
**Incident** — `incident_id`, `machine_id`, `zone`, `type`, `severity`, `occurred_at`, `root_cause`.

**Rejection policy:** rows failing schema/range checks are quarantined, not silently dropped, and
surface on a data-quality panel — a missing gas sensor is itself a safety signal.

---

# 5. Feature Store (what Stage 4 actually computes)

From a rolling 10-minute window per zone:

- **Gas:** current, mean, max, std, trend (slope), rate-of-change
- **Pressure:** current, trend, rate-of-change
- **Temperature:** current, trend · **Vibration:** current, mean
- **Operational context:** maintenance active, hot-work permit, confined-space permit, night shift,
  workers in zone, time-since-maintenance-start, time-since-permit-start
- **Interaction terms (the compound signal):** gas-trend × hot-work, pressure-trend × hot-work,
  gas × maintenance, gas-rate × maintenance, pressure-trend × maintenance

> These interactions are why the system detects *combinations* that no single sensor flags — and
> they are computed **only from observable signals**, never from ground truth.

---

# 6. Latency Budget

| Stage | Target |
|---|---|
| Ingest → normalised row | < 1 s |
| Feature computation | < 500 ms |
| Forecaster + anomaly inference | < 300 ms |
| Rule engine | < 10 ms (deterministic) |
| RAG / agent response | 2–8 s (LLM-bound) |
| End-to-end alert | **< 5 s** |

---

# 7. Failure & Degradation Behaviour

- **Sensor dropout** → feature marked missing; LightGBM handles missing natively; data-quality alert raised.
- **LLM/API unavailable** → RAG and agents fall back to **local Ollama**; the risk models and rule
  engine are unaffected (they never depend on an LLM). The safety-critical path stays online.
- **Model unavailable** → the deterministic rule engine continues to enforce hard interlocks.
- **Never fail-open:** loss of intelligence degrades to conventional alarm behaviour, not to silence.

---

# End of Document
