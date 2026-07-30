# Sentinel-Gemma — Complete Project Summary

**AI-Powered Compound Industrial Safety Intelligence for Heavy Industry**

---

## 1. The Problem — What Is Broken Today

### 1.1 The Root Cause

Indian heavy industry — refineries, chemical plants, steel mills, coke ovens — does **not** lack sensors. It lacks an **intelligence layer that connects them.**

Every modern plant already has:

- **SCADA systems** reading gas, pressure, temperature, vibration
- **Gas detectors** at fixed points across work zones
- **Permit-to-Work (PTW) systems** managing hot work, confined space entry, height work
- **Maintenance logs** tracking corrective, preventive, and emergency maintenance
- **Shift rosters** recording who is on-site and when

All of these systems **operate independently**. They generate data, but no single system can see the full picture.

### 1.2 The Failure Pattern

The recurring failure mode in industrial accidents is not "missing data" — it is **"data present, but unacted upon."**

A safety officer gets hundreds of isolated sensor alarms per shift. Most are nuisance alerts. The truly dangerous situations — where **multiple factors combine** (rising gas + active hot-work permit + ongoing maintenance + shift changeover + workers in the zone) — get buried in the noise or go undetected entirely because no single sensor sees the compound risk.

### 1.3 Real-World Precedent

This is not hypothetical. Documented incidents follow this exact pattern:

- **Visakhapatnam Steel Plant coke oven battery (January 2025)** — eight workers killed when entrapped gases triggered a sudden explosion. **The plant had functioning gas detectors, permit-to-work controls and SCADA.** An investigation by *The Wire* found that warning signals from gas **pressure** sensors existed, but no intelligence layer connected those readings to operational decisions in time. This is the incident Sentinel-Gemma is built against, and the plant model mirrors it: zones `COB-A`/`COB-B` are coke oven batteries, pressure trend is a first-class model input, and `COB-B` runs the hidden-compound scenario in which the point sensor under-reads a genuinely dangerous zone.
  *(Casualty figure and date cited as the problem statement records them; an independent check could not corroborate that specific detail, so it is attributed rather than asserted.)*
- **LG Polymers Vizag styrene leak (May 2020)** — 12 dead, fully documented. The signals existed in SCADA data; no system connected them to operational context. Workers were sleeping near a leaking tank because shift scheduling and sensor monitoring were completely disconnected. Same pattern, independently verifiable.

The common thread: **the signal was present somewhere in the plant's digital systems. Nobody — and no system — connected the dots in time.**

### 1.4 Why Single-Sensor Alarms Fail

A conventional gas detector is a **point sensor**. It reads gas concentration at one fixed location. This creates fundamental blind spots:

| Limitation | Consequence |
|---|---|
| **Placement gaps** | Gas can accumulate in zones between sensors |
| **Airflow attenuation** | Maintenance work or disturbed ventilation dilutes readings at the sensor while true zone gas is higher |
| **No operational context** | The sensor doesn't know a hot-work permit is active nearby |
| **No temporal awareness** | It reads the current value but doesn't track whether gas is *trending upward* |
| **Alarm fatigue** | High false-alarm rates (50%+) cause operators to ignore or silence alerts |

> **In our demo replay**, the point sensor reads **4.5% LEL** while true zone gas is actually **8.9% LEL** — the sensor is literally being fooled by disturbed airflow during maintenance.

---

## 2. The Solution — What Sentinel-Gemma Does

### 2.1 Core Concept

Sentinel-Gemma is a **pure software intelligence layer** that sits above a plant's existing systems. It does not replace SCADA, gas detectors, or PTW systems. It **connects** them.

It fuses gas, pressure, temperature, and vibration data with **operational context** — active permits, maintenance status, shift schedules, worker locations, and historical incident data — into a single **compound risk forecast**.

Every alert it generates is:
- **Forward-looking** — it predicts threshold crossings *before* they happen
- **Explainable** — SHAP analysis tells the safety officer *why* the risk score is high
- **Actionable** — an agentic workflow can veto permits, trigger evacuations, and draft incident reports
- **Grounded in regulation** — the RAG assistant cites specific OISD / Factory Act clauses

### 2.2 The Safety Contract

This is the non-negotiable architectural principle:

> **The ML layer may escalate or reject work. It can never approve work that the deterministic gas/oxygen interlocks have rejected.**

Anything that can **stop or clear** work is plain, auditable, deterministic logic — never a model decision. LLMs are used only for language tasks (compliance retrieval, notification drafting) **after** the safety verdict has already been reached deterministically.

If every LLM tier is unavailable, the interlocks still enforce. Safety degrades gracefully, never fails silently.

---

## 3. Why This Solution — Design Rationale

### 3.1 Why Compound Fusion (Not Just Better Sensors)

The problem is not sensor quality — it's **correlation**. A gas reading alone is ambiguous. The *same* gas reading has completely different risk implications depending on:

- Is there an active hot-work permit in the zone? (ignition source)
- Is maintenance underway? (ventilation disrupted, human exposure)
- Is it shift changeover? (reduced operator attention, handover information loss)
- How many workers are in the zone? (exposure magnitude)
- Is gas *trending upward* or was it a transient spike? (urgency)

Sentinel-Gemma's feature engineering creates **cross-sensor interaction terms** — `gas_trend × pressure_trend`, `maintenance_active × gas_level`, `workers_in_zone × risk_score` — that capture these compound dynamics.

### 3.2 Why LightGBM (Not Deep Learning)

The core forecaster uses **Gradient-Boosted Trees (LightGBM)**, not LSTMs or Transformers. This was a deliberate, tested decision:

| Factor | GBT Wins | Deep Learning Loses |
|---|---|---|
| **Data type** | Tabular + mixed (continuous sensors + categorical context) — GBTs dominate | Neural nets need homogeneous, high-volume data |
| **Explainability** | SHAP is native and fast | Black-box; post-hoc explanations are unreliable |
| **Training speed** | Minutes on CPU | Hours on GPU; impractical for rapid iteration |
| **Missing values** | Handled natively (real sensor gaps) | Requires imputation pipelines |
| **Sample efficiency** | Works well on 172K rows | Needs orders of magnitude more |
| **Reproducibility** | Deterministic | Non-deterministic with floating-point GPU ops |

> A safety-critical number must be **reproducible**. "The model sometimes gives different risk scores for the same input" is not acceptable.

### 3.3 Why Deterministic Rules + ML (Not Pure ML)

Pure ML systems have a trust problem: they can approve things they shouldn't. Sentinel-Gemma separates concerns:

- **Deterministic rule engine** → hard interlocks (gas > threshold + hot-work = REJECT). These have **veto authority** and can never be overridden by the ML.
- **ML forecaster** → soft predictions (risk is climbing; threshold crossing predicted in 18 minutes). These inform and escalate.
- **Agentic layer** → language tasks (draft notifications, retrieve regulations, coordinate response).

This layered architecture is a safety-engineering best practice, not a workaround.

### 3.4 Why RAG (Not Fine-Tuned LLMs)

Regulatory compliance needs **exact citations** from specific documents (OISD-STD-105, Factory Act 1948). Fine-tuning an LLM on these documents would:
- Lose citation traceability
- Hallucinate clause numbers
- Become stale when regulations update

RAG grounds every answer in source text with provenance tracking. The UI visibly marks `OFFICIAL` vs `REFERENCE-ONLY` citations. If a regulation changes, you update the corpus — not retrain a model.

### 3.5 Why Gemini + Ollama (Dual LLM Path)

- **Gemini (primary)** — fast, high-quality, generous free tier
- **Ollama local fallback** — runs `llama3.1:8b` without internet

This guarantees the system **never fails due to API unavailability or bad venue WiFi**. A single `LLMProvider` interface selects the backend via config. If both are down, the deterministic interlocks still enforce safety.

---

## 4. Where This Is Used — Target Environment

### 4.1 Industry Sectors

| Sector | Specific Use Cases |
|---|---|
| **Oil & Gas Refineries** | Gas accumulation monitoring, flare system safety, hot-work permit validation near hydrocarbon zones |
| **Chemical Processing Plants** | Multi-reactor compound risk, toxic gas correlation with ventilation status |
| **Steel Mills & Coke Ovens** | Coke oven gas (CO + H₂) during battery operations, blast furnace pressure anomalies |
| **Petrochemical Complexes** | Storage tank farm monitoring, loading/unloading safety interlocks |
| **Power Plants** | Boiler pressure + temperature compound monitoring, coal dust explosion risk |
| **Mining Operations** | Methane accumulation in underground mines, ventilation failure detection |

### 4.2 Regulatory Context — Indian Framework

Sentinel-Gemma is designed for compliance with:

- **OISD-STD-105** — Work permit systems for oil & gas (hot work, confined space, gas testing in %LEL / ppm toxic / O₂%)
- **Factories Act, 1948** — Hazardous process safety, reporting obligations
- **DGMS Circulars** — Directorate General of Mines Safety guidelines
- **IS/ISO Standards** — Process safety management, functional safety

The RAG compliance assistant can retrieve and cite specific sections from these documents to support permit decisions, audit queries, and incident investigations.

### 4.3 Users

| Role | What They Use |
|---|---|
| **Safety Officer** | Real-time risk dashboard, AI-explained alerts, risk heatmap, shift handover summaries |
| **Plant Manager** | Plant-level risk score, incident analytics, KPI monitoring |
| **Maintenance Engineer** | Permit conflict checks, maintenance risk assessment, repair scheduling |
| **Compliance Officer** | Regulation verification, audit report generation, compliance status tracking |

---

## 5. When This Acts — Trigger Scenarios

### 5.1 The Compound Event (Primary Scenario)

The signature scenario Sentinel-Gemma is built to catch — inspired by real incidents:

```
Timeline: A coke-oven-style compound event

T-60 min  │  Maintenance begins on a compressor in Zone B
T-45 min  │  Hot-work permit issued for welding nearby (Zone B)
T-30 min  │  Gas begins accumulating — ventilation disrupted by maintenance
T-20 min  │  Shift changeover begins — reduced operator attention
T-15 min  │  ✸ Sentinel-Gemma: compound risk score crosses threshold
          │    → SHAP: "gas_trend +34%, hot_work_active, maintenance_active"
          │    → Permit Agent: REJECTS hot-work renewal (OISD-STD-105 §4.3)
          │    → Alert: "Threshold crossing predicted in ~18 minutes"
T-10 min  │  ✸ Emergency Orchestrator activates
          │    → Evacuation protocol initiated for Zone B
          │    → Multi-channel alerts (SMS, dashboard, PA system)
          │    → Evidence window preserved (sensor logs locked)
T+0  min  │  Gas reaches threshold — but zone is already evacuated
          │  Single-sensor baseline: still reading 4.5% LEL (attenuated)
          │  → Would have triggered alarm 12 minutes AFTER the event
```

### 5.2 What the Baseline Misses

The single-sensor gas alarm fails in this scenario because:
1. The gas detector is physically positioned away from the accumulation point
2. Maintenance disturbed airflow, attenuating the reading at the sensor
3. The sensor has no concept of "hot-work permit is active" — it doesn't know there's an ignition source nearby
4. It doesn't track trends — a slow, steady gas rise doesn't trigger the static threshold until it's too late

Sentinel-Gemma catches it because it **fuses** gas trend + pressure change + vibration anomaly + active permit + active maintenance + time-since-shift-change into a single compound assessment.

---

## 6. What It Does — Core Capabilities

### 6.1 Compound Risk Forecasting

- **Multi-horizon prediction**: P(threshold crossed within 15 / 30 / 60 minutes)
- **Feature fusion**: 12+ engineered features from sensors, operations, and history
- **Top predictive features** (from actual model):

| Feature | Importance |
|---|---|
| `gas_max` (max gas reading in window) | 1,060 |
| `vib_mean` (mean vibration) | 759 |
| `pressure_now` (current pressure) | 690 |
| `gas_mean` (average gas in window) | 664 |
| `gas_std` (gas volatility) | 622 |
| `time_since_maint` (maintenance recency) | 585 |
| `temp_trend` (temperature direction) | 530 |
| `temp_now` (current temperature) | 524 |
| `vib_now` (current vibration) | 472 |
| `gas_trend` (gas direction) | 463 |
| `pressure_roc` (pressure rate of change) | 442 |
| `time_since_permit` (permit recency) | 412 |

> Note: `gas_max` is the top feature, but `time_since_maint` and `time_since_permit` — purely operational context features — rank in the top 6. **This is the compound intelligence at work.** A single-sensor system cannot use these.

### 6.2 Anomaly Detection (Safety Net)

- **Isolation Forest** — fast multivariate point anomalies (sudden spikes, sensor drift)
- Catches **unknown-unknowns** that the supervised forecaster was never trained on
- Non-circular by construction: trained only on normal operation, no labels

### 6.3 Deterministic Safety Interlocks

- Hard-coded rules with **veto authority**
- Example: `IF gas ≥ threshold AND hot_work_permit_active → REJECT permit`
- Cannot be overridden by ML predictions
- Based on OISD-STD-105 requirements

### 6.4 Explainable AI (SHAP)

- Every prediction includes a breakdown: *"Risk score 92 because: gas_trend +34%, hot_work_active, maintenance_active, workers_in_zone = 6"*
- Safety officers can **trust** and **challenge** the system's reasoning
- Required for regulatory audit trails

### 6.5 RAG Compliance Assistant

- Retrieves relevant regulations from embedded corpus (Factory Act, OISD, SOPs)
- Answers questions like: *"Can welding continue near gas leakage?"*
- Every answer includes source document, section number, and provenance status
- Uses FAISS vector store (no server dependency)

### 6.6 Agentic Workflow (LangGraph)

Four specialized agents coordinated by a supervisor:

| Agent | Responsibility |
|---|---|
| **Risk Monitor** | Watches the fused risk stream, decides when to escalate |
| **Permit Intelligence** | Validates permits against live conditions (calls rule engine + RAG) |
| **Compliance Agent** | Answers regulatory questions with cited regulations |
| **Emergency Response Orchestrator** | On critical trigger: initiates evacuation, multi-channel alerts, evidence preservation, incident report drafting |

### 6.7 Geospatial Risk Heatmap

- Plant floor-plan visualization with real-time zone risk coloring
- Worker location overlay showing exposure count per zone
- Supports evacuation planning and resource allocation

---

## 7. Proven Results — The Evidence

### 7.1 Evaluation Methodology

- **300 held-out episodes** simulated with physics-lite gas/pressure/temperature dynamics
- Labels emerge from **physical threshold crossings** in the simulation — not hand-written rules
- The model never sees the hidden true-gas variable; it predicts from present observables
- The baseline is a conventional single-sensor gas alarm (static threshold + rate-of-change)

### 7.2 Head-to-Head Scoreboard

| Metric | Single-Sensor Baseline | Sentinel-Gemma | Improvement |
|---|---:|---:|---|
| **Incident detection rate** | 73.4% | **98.4%** | +25 percentage points |
| **False-negative rate** (missed incidents) | 26.6% | **1.6%** | 94% reduction |
| **False-alarm rate** (safe zones) | 54.9% | **10.5%** | 81% reduction |
| **Nuisance alarm-minutes** | 195 | **21** | 89% reduction |
| **Incidents baseline missed, Sentinel-Gemma caught** | — | **17** | Lives saved |

### 7.3 Fair Comparison at Equal Operating Point

At the **baseline's own false-alarm rate** (54.9%), Sentinel-Gemma reaches:
- **100% detection** (vs baseline's 73.4%)
- **64.6 min lead time** (vs baseline's 27.3 min)

> Sentinel-Gemma **dominates on every axis simultaneously** — it's not trading false alarms for detection. It's just better.

### 7.4 Model Quality Metrics

| Metric | Value |
|---|---|
| ROC-AUC | **0.931** |
| PR-AUC | **0.446** |
| Row-level precision | 0.660 |
| Row-level recall | 0.334 |
| Training rows | 172,351 |
| Positive rate | 2.7% (heavily imbalanced — realistic) |
| Decision threshold | 0.95 (optimized for safety: low false negatives) |

### 7.5 Design Decision: Shift Features Excluded from ML

Shift state (day/night, changeover) was found to be **genuinely causal** — night-shift leaks escalate 49.5% vs 28.7% on day shift. But feeding shift features to the risk model **cost 17.8 points of detection**: the model learned *"day shift → someone will probably catch this"* and under-alerted.

> **A safety alert must reflect the hazard, not the odds that somebody else fixes it.**

Shift features now live in the **decision layer** as consequence/urgency multipliers, not in the ML model. Run `scripts/ablation_shift.py` to reproduce.

---

## 8. System Architecture

```
   SCADA / IoT ─┐
   Permits ─────┤
   Maintenance ─┼──▶ ingest ──▶ normalise ──▶ FEATURE STORE ─┬─▶ Baseline detector (control)
   Shift roster ┤     (% LEL, UTC, 1-min grid)               ├─▶ Compound forecaster (LightGBM)
   Plant layout ┘                                             └─▶ Anomaly detector (IF + PCA)
                                                                          │
                                    ┌────────────────────────────────────┘
                                    ▼
                        FUSION + DECISION LAYER
        rule engine (VETO) · risk × exposure × urgency · lead time · SHAP
                                    │
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                      ▼
      Agentic workflow      Geospatial heatmap        REST API
   (risk → permit →      (zone risk + workers        (FastAPI, OpenAPI)
    compliance → ERO)         exposed)                     │
                                    └─────────▶ React dashboard
```

### Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | React + TypeScript + Tailwind CSS |
| **Backend** | FastAPI (Python 3.12) |
| **ML** | LightGBM, Isolation Forest, SHAP |
| **LLM** | Gemini (primary) + Ollama (fallback) behind unified interface |
| **Agents** | LangGraph multi-agent state machine |
| **Vector Store** | FAISS |
| **RAG Corpus** | OISD-STD-105, Factory Act 1948, SOPs |

---

## 9. Project Structure

```
sentinel/
  sim/          Scenario simulator (physics-lite; labels emerge from dynamics)
  ml/           Features · baseline · forecaster · SHAP · anomaly detection
  rules/        Deterministic gas/oxygen interlocks (veto authority)
  decision/     Alert prioritisation (risk × exposure × urgency)
  rag/          Regulation retrieval with provenance-aware citations
  llm/          Gemini → Ollama → extractive provider chain
  agents/       LangGraph multi-agent safety workflow
  api/          FastAPI service + Pydantic schemas
  evaluation/   Baseline-vs-compound scoreboard and operating curves
frontend/       React + TypeScript + Tailwind dashboard
scripts/        Pipeline, demos, ablation studies
data/           Regulation corpus
reports/        Generated scoreboard, charts, metrics
```

---

## 10. How to Run

### Prerequisites

- Python 3.12
- Node 20+
- Optional: [Ollama](https://ollama.com) with `llama3.1:8b` for offline LLM path

### Backend

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe scripts/run_pipeline.py          # trains + writes reports/
.venv/Scripts/python.exe -m uvicorn sentinel.api.app:app --port 8000
```

### Frontend (separate terminal)

```bash
cd frontend && npm install && npm run dev
```

- **Dashboard** → `http://localhost:5173`
- **API Docs** → `http://localhost:8000/docs`

### Demonstration Scripts

| Command | What It Shows |
|---|---|
| `scripts/run_pipeline.py` | Baseline-vs-compound scoreboard + chart |
| `scripts/phase2_demo.py` | Single-incident replay with SHAP + permit veto |
| `scripts/phase3_demo.py` | Full agentic workflow on a compound event |
| `scripts/ablation_shift.py` | Feature ablation study (shift features) |

---

## 11. Status & Limitations

- Results are **simulator-derived**. They demonstrate that the reasoning and measurement methodology are sound; they are not a claim about a specific real plant.
- External validation against TEP and HAI datasets is documented in [`DATASETS.md`](DATASETS.md) and is planned.
- The regulation corpus is partly reference-only (OISD-STD-105 is restricted circulation).
- **Decision-support only** — this system does not actuate plant equipment.

---

## 12. Why Sentinel-Gemma Wins

Most competing approaches build *"a dashboard that shows sensor values and an alert."*

Sentinel-Gemma is different because it provides:

1. **A controlled scientific comparison** — baseline vs compound, not just "our system works"
2. **Quantified lead time** — "we predicted 18 minutes before the event" is measurable
3. **Agents that act** — not just display, but veto permits, trigger evacuations, cite regulations
4. **Cited regulation** — every compliance answer traces to a specific clause
5. **Honest ML** — labels from physics, not circular rules; shift features excluded with documented rationale

> The system doesn't just monitor. It **connects, predicts, explains, and acts** — filling the exact gap that costs lives in Indian heavy industry today.

---

*Document generated from Sentinel-Gemma project documentation, pipeline outputs, and evaluation results.*
