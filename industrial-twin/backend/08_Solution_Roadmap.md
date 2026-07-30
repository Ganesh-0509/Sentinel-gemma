# Solution Roadmap & Model Strategy

# SentinelAI
### AI-Powered Industrial Safety Intelligence Platform

**Version:** 1.0
**Status:** Supersedes the tech-stack choices in Docs 01–07 where they conflict (see §2 & §8).

---

# 0. Purpose of This Document

Docs 01–07 describe a full product. This document is the **hackathon execution strategy**: it trims scope to what wins the rubric, fixes two credibility problems in the AI approach, and defines the exact model stack, why each model was chosen over alternatives, and how everything combines.

**Team context:** ~2 week runway, small team, goal = win the hackathon.

**Winning principle:** Go *deep on one compound scenario* (coke-oven-style: gas accumulation during an active hot-work permit + maintenance + shift change — the Vizag pattern), not *broad on ten features*. If a component does not move one of the 5 evaluation metrics or 5 judging weights, it becomes a *slide*, not code.

---

# 1. Rubric & Evaluation Map (what we are optimizing)

**Judging weights:** Innovation 25% · Business Impact 25% · Technical Excellence 20% · Scalability 15% · User Experience 15%.

**Evaluation focus (the 5 metrics judges will test):**

1. Compound risk detection accuracy **vs single-sensor baselines**
2. **Prediction lead time** before incident threshold
3. **Geospatial evidence** quality
4. **Regulatory compliance coverage** (OISD / Factory Act / DGMS)
5. **Reduction in false-negative rate** — "the metric that actually saves lives"

Every build decision below traces back to one of these.

---

# 2. Scope Decision — BUILD vs SLIDE

| Component | Decision | Rubric / Metric it serves |
|---|---|---|
| Compound Risk **Forecaster** (with lead time) | BUILD — the star | Innovation + metric 2 |
| **Single-sensor baseline** to beat | BUILD — deliberately | Metrics 1 & 5 |
| Anomaly detector (unsupervised) | BUILD | Metric 5 (unknown-unknowns) |
| Rule engine (hot-work + gas veto) | BUILD — centerpiece | Business Impact + metric 4 |
| Agentic layer (4 agents) | BUILD | Innovation (multi-agent is #1 asked tech) |
| SHAP explainability | BUILD | UX + trust |
| RAG compliance (OISD / Factory Act) | BUILD — ~5 real docs | Metric 4 |
| Geospatial floor-plan heatmap + worker overlap | BUILD | Metric 3 |
| Emergency Response Orchestrator | BUILD (lightweight) | Business Impact ("first 10 min") |
| Neo4j knowledge graph | CUT → slide | High setup, low demo payoff |
| TimescaleDB / 4-DB stack | CUT → Postgres + FAISS | Simplify |
| JWT/RBAC, WebSockets, CI/CD, Docker Compose, 40+ endpoints, 1M+ records | CUT → slide | Zero rubric points |
| CCTV / vision | Keep excluded | Out of scope (correct) |

---

# 3. The Two Credibility Fixes

## Fix A — Kill the circular ML

**Problem:** generating data from rules and then training a model to re-learn those rules proves nothing; a technical judge spots it instantly.

**Fix:** the scenario simulator generates realistic **sensor dynamics** (gas builds up, pressure rises over time). It does **not** hand-assign risk labels. The **ground-truth label is a physical threshold crossing in the future** (e.g., gas ≥ LEL, or an ignition condition) that *emerges* from the dynamics. The model predicts that future crossing from the present — honest, non-circular forecasting.

## Fix B — Add prediction lead time

Reframe from "classify current state" → **multi-horizon forecast**: P(threshold crossed within next 15 / 30 / 60 min). The earliest horizon whose probability exceeds threshold **is** the lead-time number. This unlocks evaluation metric 2 (currently scored zero).

---

# 4. Model Stack — What, Why (not the alternatives), and How They Combine

Seven tiers. The right tool per job — not one model for everything.

## Tier 0 — Single-Sensor Baseline (the control group)
- **What:** per-sensor static threshold + rate-of-change trip (classic SCADA alarm logic).
- **Why build it:** it is the *scientific control*. Metrics 1 & 5 require it to exist. ~50 lines. It is the thing the headline chart beats — a deliberate deliverable, not a throwaway.

## Tier 1 — Compound Risk Forecaster (the star)
- **Model:** Gradient-Boosted Trees — **LightGBM (or XGBoost)** on engineered temporal + operational + spatial features. Output = P(threshold crossed within 15/30/60 min).
- **Why GBT wins in this regime:**
  1. Data is tabular + limited + mixed (continuous sensors + categorical context) → GBTs beat deep nets.
  2. **SHAP is native** → explainability metric nearly for free.
  3. **Fast** training/iteration → essential in 2 weeks.
  4. Handles **missing values** natively (real sensor gaps).
  5. Feature importance shows *gas-trend × active-hot-work-permit* was weighted → **proves the "compound" claim** on screen.
- **Why NOT the alternatives:**
  - LSTM / GRU / TCN / Transformer (PatchTST): overfit small/synthetic data, slower, harder to explain, don't beat GBTs here. Keep **one LSTM as an ablation** to show it was tested and GBT won.
  - Logistic regression / single threshold: that's the baseline being beaten.
  - LLM as risk predictor: wrong tool — weak at numeric time-series, slow, non-deterministic. A safety number must be reproducible.
- **Where the "compound" intelligence lives:** feature engineering — rolling stats, trends, rate-of-change, **cross-sensor interaction terms** (gas_trend × pressure_trend), time-since-permit-issued, maintenance-active × gas-level, workers-in-zone, shift-changeover flag.

## Tier 2 — Unsupervised Anomaly Detector (the safety net)
- **Models:** **Isolation Forest** (fast multivariate point anomalies) + **LSTM-Autoencoder** (temporal reconstruction error).
- **Why:** the supervised forecaster only knows trained scenarios; the AE (trained only on normal operation, no labels) flags novel/unseen patterns → attacks metric 5 (false negatives). Non-circular by construction.
- **Why both, not just Isolation Forest:** IF ignores temporal dynamics (per-timestamp); the AE captures sequence shape. IF = cheap point check, AE = temporal check.
- **Credibility move:** validate the AE on a real public ICS dataset (Tennessee Eastman / HAI — see §5) to prove generalization beyond the simulator.

## Tier 3 — Deterministic Rule / Constraint Engine (hard safety interlocks)
- **Model:** none — pure deterministic logic. E.g., *hot-work permit requested while zone gas ≥ threshold %LEL → REJECT* (OISD-STD-105).
- **Why deterministic, not ML:** never let a probabilistic model *approve* a safety violation. "We ML the predictions; we hard-code the guarantees" is a maturity signal judges respect.

## Tier 4 — Explainability (SHAP)
- On the GBT. Turns "risk 92" into *gas-trend +34%, hot-work active, maintenance active, workers-in-zone = 6.* → trust + UX.

## Tier 5 — RAG Compliance Assistant (LLM + retrieval)
- **Stack:** embeddings → **FAISS** (no server; simpler than Chroma) → LLM via a **provider-abstraction layer**.
- **LLM providers (both, behind one interface):**
  - **Gemini (Flash)** = primary. Cheap, fast, high quality, generous free tier.
  - **Ollama (local)** = fallback / offline. No API key, runs without internet — **guarantees the live demo never fails on venue wifi.** A single `LLMProvider` interface selects Gemini or Ollama via config/env.
- **Corpus (real docs):** OISD-STD-105 (work permits: hot work, confined space, gas testing in %LEL / ppm toxic / O₂ %), Factory Act 1948 (hazardous-process sections), relevant OISD standards, DGMS circulars.
- **Why RAG not fine-tuning:** regulations need exact citations, change over time, and have no training set. RAG grounds answers in source text → metric 4.

## Tier 6 — Agentic Orchestration Layer (the "multi-agent" the problem demands)
- **Framework:** **LangGraph** (controllable state-machine multi-agent — reproducible and explainable, which a safety workflow needs). Plain function-calling is the fallback if time is tight.
- **Agents:**
  - **Risk Monitor Agent** — watches the fused risk stream, decides when to escalate.
  - **Permit Intelligence Agent** — checks active/requested permits vs live conditions (calls rule engine + RAG).
  - **Compliance Agent** — answers "is this allowed?" with a cited regulation.
  - **Emergency Response Orchestrator** — on confirmed critical trigger: initiates evacuation protocol, multi-channel alerts, preserves the sensor-evidence window, drafts a regulator-format incident report ("first 10 minutes").
  - **Supervisor** node — routes between agents.
- **Why agentic here and not everywhere:** the response workflow is genuinely multi-step, dynamic, language-heavy (detect → verify → decide → act → notify → document). Hard safety stays deterministic. This division is the mature answer to "why agents?"

## How It All Combines — Fusion Architecture

```
        Sensor streams + Permit/Maintenance/Shift logs + Plant layout
                                  |
                                  v
                          FEATURE STORE
        (rolling stats, trends, rate-of-change, cross-sensor
         interactions, operational + spatial context features)
                                  |
   +---------------+--------------+--------------+-----------------+
   v               v                             v                 v
 Tier0 BASELINE  Tier1 GBT FORECASTER      Tier2 ANOMALY   spatial exposure
 (per-sensor)    P(cross 15/30/60m)        IF + LSTM-AE    (workers-in-zone)
   |               |                             |                 |
   +---------------+--------------+--------------+-----------------+
                                  v
                     FUSION & DECISION LAYER
    1. Rule engine (Tier3) has VETO — hard interlocks override all
    2. Calibrated compound risk score = f(GBT prob, anomaly score, exposure)
    3. Lead-time = earliest horizon whose prob > threshold
    4. Alert priority = risk x people-exposed x asset-criticality
                                  |
        +-------------------------+-------------------------+
        v                         v                         v
   SHAP explanation      AGENTIC LAYER (Tier6)      Geospatial heatmap
   (why this score)      Permit / Compliance /       (zone risk + worker
                         Emergency Orchestrator       overlap on floor plan)
                         <- uses RAG (Tier5)
                                  |
                                  v
                        DASHBOARD + ACTIONS
```

**Combination rules in words:** the rule engine can always **veto** (safety first). Otherwise the three detectors are **fused** into one calibrated score; the GBT supplies **lead time**; prioritization **de-noises**; SHAP **explains**; the agents **act**. Entity context (which worker/permit/zone) uses plain **Postgres joins + a lightweight in-memory graph** for the demo; "Neo4j knowledge graph" is a future-scope slide.

---

# 5. Data Plan (real, usable sources)

- **Core = scenario simulator** (physics-lite gas/pressure/temp dynamics + operational events). Present it honestly as a simulator; labels emerge from threshold crossings (Fix A).
- **Real public datasets to anchor credibility (pick 1–2):**
  - **Tennessee Eastman Process (TEP)** — free; chemical process with ~20 fault types → best for the anomaly detector.
  - **HAI ICS security dataset** — free on GitHub; labeled ICS anomalies.
  - **UCI Gas Sensor Array Drift** — free; real gas-sensor signatures/drift (realism + a drift-anomaly angle).
  - **SWaT / WADI** — gold standard but **access-gated** (request from SUTD iTrust; may not arrive in time). Mention as a validation target; do not depend on it.
- **Regulatory corpus (real):** OISD-STD-105 (hot work, confined space, gas testing in %LEL / ppm / O₂ %), Factory Act 1948 hazardous-process sections, DGMS circulars.

---

# 6. Demo Script (~4 min, hits all 5 metrics)

1. **Setup (15s):** coke-oven-style scenario — gas accumulation during active hot-work permit + maintenance + shift change (the Vizag pattern: the signal existed; nobody connected it).
2. **Baseline fails (30s):** single-sensor alarm floods with nuisance alerts or misses the compound event — show the count.
3. **SentinelAI catches it (45s):** compound risk climbs; lead-time forecast: *"threshold crossing predicted in ~18 min."*
4. **It explains itself (30s):** SHAP panel — why.
5. **It acts (60s):** Permit Agent rejects the hot-work permit with an OISD-STD-105 citation; Emergency Orchestrator triggers evac + alerts + evidence capture + draft incident report.
6. **Geospatial (20s):** floor-plan heatmap lights the zone; shows workers in the danger zone.
7. **Scoreboard (30s):** side-by-side baseline vs SentinelAI — false negatives, false alarms, lead time. The slide that wins.

> **Demo anchor:** Vizag coke-oven incident, worded faithfully to the problem statement. Do **not** invent specific figures — an independent search could not confirm the exact "8 deaths, January 2025 coke oven" detail (a Coke Oven Battery-2 fire on ~10 Feb 2025 with a worker injured was found instead). Cite as the problem statement frames it; the verified LG Polymers Vizag styrene leak (May 2020, 12 dead) is a documented fallback with the same "signal ignored" pattern.

---

# 7. Two-Week Parallel Plan

**Week 1 — prove the core**
- **Sim + Data (A):** scenario simulator + threshold-crossing labels + pull TEP/UCI. → Day 4
- **ML (B):** baseline + GBT forecaster + SHAP; anomaly detector. → Day 6
- **Agents + RAG (C):** FAISS + OISD/Factory Act ingest; rule engine; Permit/Compliance agents; Gemini+Ollama abstraction. → Day 7
- **Frontend (D):** dashboard shell + floor-plan heatmap + risk timeline. → Day 6

**Week 2 — fuse, polish, win**
- Day 8–9: fusion layer + Emergency Orchestrator + wire agents to UI.
- Day 10–11: **baseline-vs-SentinelAI evaluation harness** (produces the headline chart — highest priority).
- Day 12: architecture diagram + deck (lead with the scoreboard) + record demo video.
- Day 13–14: buffer, rehearse the 4-min demo, freeze.

---

# 8. Revised Tech Stack (supersedes Docs 01–07)

| Layer | Keep | Cut / defer |
|---|---|---|
| Frontend | React + TS + Tailwind; floor-plan heatmap (SVG/Canvas or Leaflet with `CRS.Simple`) | — |
| Backend | FastAPI (Python 3.12) | WebSockets (poll instead), JWT/RBAC |
| ML | LightGBM/XGBoost, Isolation Forest, LSTM-AE, SHAP | — |
| LLM | Gemini (primary) + Ollama (fallback) behind one interface; LangGraph | OpenAI (optional) |
| Vector store | FAISS | ChromaDB |
| DB | PostgreSQL (single) | TimescaleDB, Neo4j |
| Infra | Local run; single `docker-compose` optional | CI/CD, Nginx, multi-service prod |

---

# 9. Why We Out-Frame Competitors

Most teams build "a dashboard that shows sensor values and an alert." SentinelAI is the only entry that shows a **controlled comparison** (baseline vs compound), a **quantified lead time**, an **agent that acts** (not just displays), and **cited regulation** — mapping directly to Innovation (25) + Business Impact (25) + the exact evaluation metrics.

---

# End of Document
