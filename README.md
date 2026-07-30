# Sentinel-Gemma

**An agent that proposes. A plant that decides.**

Compound industrial safety intelligence, with a local Gemma 3 as the reasoning
engine and a deterministic gate standing between its proposals and the plant.

Indian heavy industry does not lack sensors. It lacks an intelligence layer that
connects them. SCADA, gas detectors, permit-to-work systems, maintenance logs and
shift rosters all generate data, and all operate independently — so the dangerous
condition is rarely a single reading out of range. It is a *combination*: gas
rising while a hot-work permit is open, while maintenance has disturbed
ventilation, during a shift changeover, with a crew in the zone. Every individual
reading looks acceptable. A gas detector at 4 %LEL reports "safe" and is correct
about the only question it was asked.

Sentinel-Gemma sits above existing plant systems, fuses those signals into a
forward-looking explainable forecast, and then *acts* on it — revoking permits,
raising alarms, purging ventilation, dispatching teams — with every action
authorised against auditable logic rather than a model's confidence.

> **The safety contract**
>
> The machine-learning layer may **escalate or reject** work. It can never
> approve work that the deterministic gas and oxygen interlocks have rejected.
>
> Anything that can stop or clear work is plain, auditable logic. Model output
> moves a decision in one direction only: `APPROVED → CONDITIONAL → REJECTED`.
> There is no code path by which a probability loosens a verdict, and a test
> sweeps the model across its full output range at every gas level to prove it.
>
> Gemma widens what the system can autonomously **do**. It never widens what the
> system is allowed to **decide**.

**Model:** Gemma 3 (`gemma3:latest`, 4B) via Ollama — running locally, no cloud
call, plant telemetry never leaves the site.

```bash
ollama pull gemma3 && python -m pip install -e . && python -m uvicorn sentinel.api.app:app --port 8000
cd frontend && bun install && bun run dev      # → http://localhost:8080
```

---

## Contents

- [Results](#results)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [The Gemma agent layer](#the-gemma-agent-layer)
- [How risk is computed](#how-risk-is-computed)
- [Two properties we guarantee](#two-properties-we-guarantee)
- [API](#api)
- [Operator console](#operator-console)
- [Configuration](#configuration)
- [Testing](#testing)
- [Regulation corpus and provenance](#regulation-corpus-and-provenance)
- [Known limitations](#known-limitations)
- [Repository layout](#repository-layout)

---

## Results

Held-out evaluation over **600 replayed episodes** (126 with a genuine incident,
251 genuinely safe, 223 near-misses excluded from false-alarm denominators —
alerting on a developing hazard that was later isolated is correct behaviour,
not a false alarm).

| Metric | Single-sensor baseline | SentinelAI | |
|---|---:|---:|---|
| Incident detection rate | 66.7% | **100.0%** | ▲ 33.3 pp |
| False-negative rate (missed) | 33.3% | **0.0%** | ▼ 33.3 pp |
| False-alarm rate (safe zones) | 51.4% | **4.0%** | ▼ 47.4 pp |
| Nuisance alarm-minutes | 366 | **11** | ▼ 97% |
| Matched lead time | **34.8 min** | 15.7 min | ▼ 19.1 min |

**42 incidents the baseline missed entirely were caught by the compound model** —
each one a combination no single sensor could see.

### Read the lead-time row honestly

The baseline wins it. It warns ~19 minutes earlier on the incidents both
detectors caught, because it buys that lead by tripping on **half of all safe
episodes**. An alarm that fires on every other quiet shift is one operators learn
to silence, which is exactly the alarm-fatigue failure mode this project exists
to address.

Detection rate, false negatives and false-alarm rate must be read together.
Lead time in isolation is a misleading number, and this project does not
present it as a win. The operating threshold is tunable
(`--fa-cap`) if a site would rather trade nuisance for warning time.

The baseline is a deliberate, fair implementation of classic SCADA alarm logic
(`gas ≥ 10 %LEL`), not a strawman — it is the scientific control the whole
evaluation rests on.

---

## Quick start

**Requirements:** Python ≥ 3.11, [Bun](https://bun.sh) ≥ 1.3,
[Ollama](https://ollama.com) with Gemma 3

### 1. Gemma

The agent layer and all prose run on a local Gemma 3. Everything else works
without it — every Gemma node records its own absence and the interlocks still
enforce — but the agent panels will be empty.

```bash
ollama pull gemma3          # 3.3 GB
ollama list                 # expect gemma3:latest
```

### 2. Backend

```bash
python -m pip install -e .        # installs the sentinel package + dependencies
python -m pip install langgraph   # optional: multi-agent workflow
```

Train the forecaster and produce the evaluation scoreboard. **The API stays in a
`degraded` state until this has run at least once** — it needs
`models/forecaster.pkl`.

```bash
python scripts/run_pipeline.py            # ~3 min, 3000 episodes
python -m uvicorn sentinel.api.app:app --port 8000
```

- Interactive API contract: <http://127.0.0.1:8000/docs>
- Readiness: <http://127.0.0.1:8000/api/v1/health>
- Agent model: <http://127.0.0.1:8000/api/v1/gemma/status>

`/health` never returns 503. It reports `degraded` and names what is missing.

### 3. Console

```bash
cd frontend
bun install
cp .env.example .env               # points at http://127.0.0.1:8000
bun run dev
```

<http://localhost:8080>

### 4. Verify

```bash
python -m pytest tests -q          # 217 tests
```

---

## Architecture

```
      SCADA · gas detectors · permits · maintenance · shift roster
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   Feature engineering  │  rolling stats, trends,
                    │   (23 features)        │  rate-of-change, and
                    └────────────────────────┘  cross-sensor interactions
                                 │
        ┌────────────────┬───────┴────────┬──────────────────┐
        ▼                ▼                ▼                  ▼
   Tier 0            Tier 1           Tier 2            Spatial
   Baseline          Compound         Anomaly           exposure
   (control)         forecaster       detector          (crew in zone)
   gas ≥ 10 %LEL     LightGBM         IsolationForest
                     15/30/60 min     + PCA residual
        └────────────────┴───────┬────────┴──────────────────┘
                                 ▼
                    ┌────────────────────────┐
                    │  FUSION & DECISION     │
                    │  1. Interlocks VETO    │ ← deterministic, always wins
                    │  2. Calibrated score   │
                    │  3. Lead time          │
                    │  4. Priority ranking   │
                    └────────────────────────┘
                                 │
        ┌────────────────┬───────┴────────┬──────────────────┐
        ▼                ▼                ▼                  ▼
   SHAP             Multi-agent       RAG compliance     3D digital twin
   explanation      workflow          (FAISS-free        (live zone risk
   (why this        (LangGraph +      TF-IDF + Gemma)    on plant model)
    score)          local Gemma)
```

---

## The Gemma agent layer

Agent reasoning runs on **Gemma 3** (`gemma3:latest`, 4B) through Ollama, on the
same machine as the API. Nothing is sent to a cloud model: prose generation now
prefers the same local Gemma, and reaching a hosted model takes an explicit
`SENTINEL_LLM_PREFER=gemini`.

```
risk_monitor ──┬── below threshold ──▶ monitor_only ──▶ END
               │
               └─▶ permit_intelligence ──▶ compliance
                                              │
                   ┌──────────────────────────┴──────────────┐
                   ▼                                         ▼
            gemma_containment                            advisory
                   │                                         │
            gemma_reflection                            gemma_advisor ──▶ END
                   │
            emergency_orchestrator ──▶ END
```

`risk_monitor` and `permit_intelligence` are still LLM-free. The permit verdict
is reached by the rule engine before any Gemma node runs, and the Gemma layer
widens what the system can autonomously *do* without widening what it is allowed
to *decide*.

### Why proposals, not function calls

Gemma 3 has no tool-calling template in Ollama — posting `tools` to `/api/chat`
returns `"gemma3:latest does not support tools"`. So agents propose containment
actions as JSON constrained by Ollama's `format` parameter, and
`backend/agents/tools.py` decides what executes.

That constraint landed somewhere better than native function calling would have.
On a system that can stop work in a live plant, the useful question is not *can
the model call a function* but *who is accountable when it calls the wrong one*:

```
Gemma proposes ─▶ coerce arguments ─▶ authorise against the
                                      deterministic verdict ─▶ execute or refuse
```

`format` constrains shape and knows nothing about meaning, and the model
demonstrably exploits the gap. Measured output for a Zone-4 hot-work scenario —
all valid JSON, all wrong:

| What it returned | What the gate does |
|---|---|
| `rate: "Maximum"`, `direction: "Upward"` | Coerced to `target_cfm`, clamped to fan range |
| `severity: "Critical"` | Mapped to `LEVEL_3`; unspecified levels fail *upward* |
| `permit_id: "HOT-WORK-4-23"` | Discarded — nothing upstream issues permit numbers |
| `muster_point: "Docking Bay Alpha"` | Discarded — no such location exists |
| `trigger_zone_alarm` three times | Duplicates collapsed |
| Cited HAZWOPER | Not in the corpus; standards come from RAG, not the model |

Restrictive actions additionally require the deterministic layer to have
escalated, and `veto_permit` requires an interlock rejection — a permit is
revoked by the rule engine, never by a language model. Ventilation is exempt,
because purging removes the hazard rather than restricting people.

The model's self-reported confidence is displayed but never gated on. It returned
0.95 on a zone the rule engine had cleared, which is not evidence of anything.

Refusals are returned as receipts alongside executions and rendered in the
console. A withheld action is the visible evidence that the gate works, and an
operator reviewing an incident needs to know what the agent wanted to do.

### Latency

Generation is the whole cost. Measured on a CPU-bound box: **10.7 tok/s**
generation against ~84 tok/s prompt eval. Long prompts are nearly free, long
answers are not — so the schemas are tight, output caps are low, and there are
three Gemma nodes rather than five. With the model resident in VRAM this drops by
roughly an order of magnitude.

`GET /api/v1/gemma/status` reports model identity and reachability from Ollama's
tag list without spending a generation. Per-node latency is returned with every
workflow run, and reports model load separately from generation time: Ollama
evicts an idle model and charges the reload to whichever node runs next, which
made one 43-token answer measure 0.7 tok/s against ~10 tok/s warm.

If Gemma is unreachable, every node records its own absence and the graph still
completes. The forecaster, the rule engine and the interlocks do not depend on it.

**Why the layers are separated.** Hazard, consequence and urgency are distinct
questions. `risk` answers *"how likely is an incident?"* and nothing else.
Exposure (how many people) and urgency (night shift, changeover) are applied at
the decision layer, where they raise an alert's priority without ever lowering
the assessed hazard.

This is not academic. Including shift features in the hazard model taught it that
a hazard on day shift was less likely to become an incident, because a human
would probably catch it. True — and exactly the wrong thing for a hazard model to
learn, because it suppresses the alert precisely when the alert is doing its job.
Those features live in `SHIFT_FEATURE_GROUP` and are routed to the decision
layer instead.

---

## How risk is computed

### Tier 0 — Single-sensor baseline (the control)

Classic SCADA alarm logic: `gas_sensor ≥ 10 %LEL`. Roughly fifty lines. It exists
to be measured against, and it is implemented fairly.

### Tier 1 — Compound risk forecaster

**LightGBM**, one model per horizon in `{15, 30, 60}` minutes, predicting
P(threshold crossing within the horizon) from 23 engineered features.

Gradient-boosted trees over a deep sequence model because the data is tabular,
limited and mixed-type; because SHAP attributions come natively, so every alert
is explainable; and because missing values — real sensor gaps — are handled
without imputation.

The compound intelligence lives in the **interaction terms**:
`gas_trend × hot_work`, `gas_now × maintenance`, `gas_roc × maintenance`,
`pressure_trend × hot_work`. These are the features that encode "several ordinary
things happening at once."

### Tier 2 — Unsupervised anomaly detection

`IsolationForest` plus PCA reconstruction error, fitted on normal operation only.
The supervised forecaster knows the scenarios it was trained on; the anomaly
detector flags patterns nobody anticipated.

### Tier 3 — Deterministic interlocks

No model. Plain thresholds, aligned to OISD-STD-105 practice:

| Condition | Limit | Outcome |
|---|---|---|
| Hot work | gas ≥ 5.0 %LEL | REJECT |
| Confined space | gas ≥ 5.0 %LEL, or O₂ outside 19.5–23.5% | REJECT |
| All other permits | gas ≥ 10.0 %LEL | REJECT |
| Compound watch | gas ≥ 3.0 %LEL, rising, maintenance active | CONDITIONAL |

Standing interlocks apply with no permit request at all: active hot work above
the hot-work limit triggers suspension; gas above the general limit with workers
present triggers evacuation.

### Tier 4–6 — Explanation, retrieval, orchestration

SHAP drivers on every alert above 25% risk. A TF-IDF retrieval layer over the
regulation corpus with a **Gemini → Ollama → extractive** provider fallback. A
LangGraph workflow with `risk_monitor`, `permit_intelligence`, `compliance`,
`emergency_orchestrator` and `advisory` nodes.

The language model never makes a safety verdict. It drafts notifications and
retrieves regulation text *after* the deterministic decision is already made. If
every LLM tier is unavailable the interlocks still enforce and the compliance
assistant returns retrieved source text verbatim.

---

## Two properties we guarantee

### 1. More gas can never mean less risk

The forecaster originally learned a *scenario fingerprint* rather than physical
causality. In the hidden-leak scenario the point sensor reads low while the zone
is genuinely dangerous, so "low reading alongside other danger cues" became
evidence of danger — and raising the measured gas made the forecast **collapse
from 0.67 to 0.00**.

For a safety system that is indefensible. An operator watching gas climb must
never see risk fall.

Two mechanisms enforce the fix, and **both are required**:

1. **Monotone constraints** on the gas level and trend features in LightGBM.
2. **Level-shift what-if semantics.** Applying an override as a *ramp* reaches
   the current minute mid-slope and perturbs `gas_std` — volatility, which is
   deliberately left unconstrained because dispersion is genuinely two-sided.
   The guarantee leaked through that unconstrained feature even with the
   constraint in place. Shifting the whole feature window uniformly moves only
   the constrained level terms.

Verified live across all eight zones, gas +0 → +20 %LEL:

```
COB-B   0.648 0.648 0.648 0.648 0.648 0.658 0.697 0.723
SIN-1   0.770 0.770 0.770 0.770 0.772 0.788 0.795 0.816
ALL ZONES MONOTONE: PASS
```

### 2. Lead time is a forecast, not a lookup

`config.HORIZONS = [15, 30, 60]` trains one model per horizon. The **earliest
horizon whose probability clears its own tuned threshold** is the reported
warning time — a shorter horizon firing means the crossing is nearer.

An earlier implementation returned `incident_onset - minute`: the simulator's
answer key, presented as a prediction. A test now asserts every reported lead
time is one of the trained horizons, which is what makes it verifiable rather
than merely claimed.

---

## API

Base URL `http://127.0.0.1:8000/api/v1`. Every response is a declared Pydantic
model, so `/docs` is an integration contract rather than a debug page. Errors are
RFC-7807-style problem details.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Readiness, model status, LLM backend, corpus size |
| `GET` | `/zones` | Live state for all zones |
| `GET` | `/zones/{id}` | One zone |
| `GET` | `/zones/{id}/history?window=` | Minute-indexed telemetry |
| `GET` | `/clock` | Current plant minute |
| `POST` | `/clock/tick?steps=` | Advance the replay clock |
| `POST` | `/clock/set?minute=` | Jump to a minute |
| `GET` | `/alerts` | Prioritised alert queue |
| `POST` | `/permits/evaluate` | Deterministic interlock decision |
| `POST` | `/simulate` | Re-score all zones under what-if overrides |
| `POST` | `/simulate/{id}` | Re-score one zone |
| `POST` | `/compliance/ask` | RAG-grounded regulatory answer |
| `POST` | `/workflow/run/{id}` | Multi-agent safety workflow |
| `GET` | `/evaluation/scoreboard` | Baseline-vs-compound evidence |

`/permits/evaluate` and `/zones` never depend on the LLM and stay available if it
is down. `/compliance` and `/workflow` degrade.

### The plant clock

The backend precomputes a 240-minute episode per zone and exposes a pointer into
it. This makes the whole system reproducible: the same clock minute always yields
the same telemetry, the same risk and the same alerts, so a demo is repeatable
and a bug is reproducible.

---

## Operator console

React 19 · TanStack Start · Three.js · Tailwind v4. Eleven screens, all reading
live backend state.

| Screen | What it shows |
|---|---|
| **Dashboard** | Zone risk map, prioritised alerts, SHAP drivers, backend health |
| **Digital Twin** | 3D plant model with live zone risk as column height |
| **Live Replay** | Clock-driven replay with transport controls and scrubber |
| **Risk Analytics** | Risk distribution, per-zone bands, gas/risk/vibration traces |
| **Command Center** | Alert queue joined to zone state, agent workflow execution |
| **Agent Workflow** | Real LangGraph trace, permit decision, interlocks, actions |
| **Permit Intelligence** | Live interlock evaluation against real zone conditions |
| **Compliance Assistant** | RAG answers with provenance-badged citations |
| **Incident Investigation** | Episode trajectory, SHAP factors, model vs baseline |
| **What-If Simulation** | Counterfactual scored by the real forecaster |
| **Evidence Panel** | The scoreboard, including where the baseline wins |

The what-if page does not approximate the model client-side. Every slider change
posts to `/simulate`, which re-runs the same feature pipeline and the same
trained forecaster used for live scoring.

---

## Configuration

All optional; every value has a working default.

| Variable | Default | Purpose |
|---|---|---|
| `SENTINEL_CORS_ORIGINS` | localhost 5173/8080/3000 | Comma-separated allowed origins |
| `GEMMA_MODEL` | `gemma3:latest` | Model behind the agent layer and prose |
| `GEMMA_NUM_CTX` | `8192` | Context window. The Ollama default of 4096 truncates from the front, dropping the system instruction first |
| `GEMMA_TEMPERATURE` | `0.1` | Agent decisions should be defensible in an incident review |
| `OLLAMA_URL` | `http://localhost:11434` | Where Gemma runs |
| `SENTINEL_LLM_PREFER` | unset (local) | Set to `gemini` to move *prose* to the cloud tier. Requires `GEMINI_API_KEY`. Agent reasoning stays local either way |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Only read when the cloud tier is explicitly preferred |
| `GEMINI_MODEL` | `gemini-2.0-flash` | |
| `SENTINEL_EMBED` | unset (TF-IDF) | Set to `ollama` for embedding retrieval |
| `VITE_API_URL` *(console)* | `http://127.0.0.1:8000` | Backend base URL |

The cloud tier requires an explicit opt-in rather than just a key in the
environment. A stray `GEMINI_API_KEY` should not be able to move inference
off-site during a demo that is meant to be running locally.

Model constants — gas thresholds, horizons, feature window, seed — live in
`backend/config.py`. They are configuration, not model output; changing them is a
controlled change.

### Why the package mapping

Every module imports `from sentinel...` while the code lives in `backend/`.
Rather than rewrite 27 files of reviewed logic, `pyproject.toml` maps the package
name onto the directory:

```toml
[tool.setuptools.package-dir]
"sentinel" = "backend"
```

`pip install -e .` makes `import sentinel` resolve to `backend/`. Folder name and
import name are both preserved.

---

## Testing

```bash
python -m pytest tests -q
```

54 tests. The two that matter most:

**The safety contract.** Model output is swept across its entire range at every
gas level, asserting the verdict is never weaker than the deterministic one. If
the model can ever loosen a decision, this fails.

```python
@pytest.mark.parametrize("risk", [0.0, 0.25, 0.5, 0.75, 0.9, 1.0])
@pytest.mark.parametrize("gas",  [0.0, 2.0, 4.0, 6.0, 12.0, 40.0])
def test_model_can_only_tighten_never_loosen(risk, gas):
    assert STRICTNESS[decide(gas_lel=gas, risk=risk).status] \
        >= STRICTNESS[decide(gas_lel=gas).status]
```

**Gas monotonicity**, as a regression against the failure described above, plus a
test asserting lead time is always one of the trained horizons — the proof it is
not being read off the label.

`scripts/run_pipeline.py` also verifies monotonicity at training time and records
the result in `scoreboard.json`, so a regression surfaces during training rather
than in front of an operator.

---

## Regulation corpus and provenance

Documents in `data/regulations/` are **paraphrased summaries**, marked
`provenance: SUMMARY`. Every citation they produce is stamped
`[development summary — not official text]`.

They deliberately avoid asserting specific clause numbers. A paraphrase attached
to a fabricated clause number is worse than no citation at all — it is the kind of
detail that looks authoritative and cannot survive being checked.

If your site holds licensed copies of the real standards, place them in
`data/regulations_local/` (git-ignored). Anything loaded from there is marked
`OFFICIAL` automatically and takes precedence.

Do not raise a summary's provenance to make a demo look better.

---

## Known limitations

Stated plainly, because a safety system that oversells itself is worse than one
that doesn't exist.

- **The simulator is a simulator.** Physics-lite gas/pressure/temperature
  dynamics. Incident labels *emerge* from threshold crossings rather than being
  hand-assigned, which keeps the learning problem honest — but this is not
  validated against plant data. `backend/DATASETS.md` lists the public ICS
  datasets (Tennessee Eastman, HAI, UCI Gas Sensor Drift) intended for external
  validation.
- **Lead time is worse than the baseline's** at the current operating point.
  See [Results](#results).
- **The 3D geometry is authored, not derived.** Buildings and tanks are matched
  to backend zones by string ID only. Zone risk, gas and crew counts are live;
  the model of the plant itself is not. There is no `/assets` endpoint, so the
  two can drift.
- **No per-device telemetry.** The API is zone-level. There is no sensor
  inventory, no CCTV, no named personnel — only `workers_in_zone` as a count.
  UI that implied otherwise was removed rather than faked.
- **The permit endpoint is stateless.** It evaluates a hypothetical permit. There
  is no register of issued permits and no revocation workflow.
- **Retrieval is TF-IDF by default.** Semantic embedding retrieval is available
  behind `SENTINEL_EMBED=ollama` but is not the default path.

---

## Repository layout

```
backend/          Python package, imported as `sentinel.*`
  api/            FastAPI app, Pydantic schemas, plant service
  sim/            Scenario simulator
  ml/             Features, forecaster, anomaly detector, SHAP, baseline
  rules/          Deterministic interlocks
  decision/       Priority and exposure weighting
  agents/         LangGraph safety workflow
    graph.py      The 9-node state machine
    gemma_nodes.py  The three Gemma agents
    tools.py      Containment tools and the authorisation gate
  llm/            Provider abstraction with tiered fallback
    gemma.py      Local Gemma client, schema-constrained decoding
  rag/            Regulation store and compliance assistant
  evaluation/     Episode-level scoreboard harness
frontend/         Operator console (React 19 + TanStack Start + Three.js)
  src/components/gemma/   Tool stream, reasoning, briefing, telemetry panels
scripts/          run_pipeline.py — train, tune, evaluate
tests/            Interlock, model-property and agent-gate tests
data/regulations/ RAG corpus (see its README on provenance)
models/           Trained forecaster — committed, so a fresh clone runs
reports/          Evaluation scoreboard — committed
```

**Start here** if you are reviewing the Gemma integration:
`backend/agents/tools.py` (the gate), then `backend/agents/gemma_nodes.py` (the
agents), then `tests/test_gemma_tool_gate.py` (what the gate actually catches).

---

## Acknowledgements

This system is built directly against the incident the problem statement
records: **Visakhapatnam Steel Plant, January 2025**, where entrapped gases
triggered a sudden explosion in the **coke oven battery**, killing eight
workers.

The detail that matters is not that the plant lacked safety systems. It had
them — gas detectors, permit-to-work controls, and SCADA, all functioning. As
the problem statement notes, an investigation by *The Wire* found that warning
signals from **gas pressure sensors existed**, but no intelligence layer
connected those readings to operational decisions in time.

That is the exact failure mode this project addresses, and the plant model
reflects it deliberately:

| The incident | This system |
|---|---|
| Coke oven battery | Zones `COB-A` and `COB-B` are coke oven batteries; `COB-B` runs the hidden-compound scenario |
| Entrapped gas the point sensors under-read | `gas_true` vs an attenuated `gas_sensor` — the core of the simulator |
| Gas **pressure** warnings that went unconnected | `pressure_now`, `pressure_trend`, `pressure_roc` are model inputs, and `pressure_trend_x_hotwork` / `pressure_trend_x_maint` are explicit compound terms |
| Detectors, permits and SCADA that did not talk | Fusing exactly those streams is the entire premise |

> **On sourcing.** The casualty figure and date above are cited as the problem
> statement frames them. An independent check could not corroborate that
> specific detail, so it is attributed rather than asserted — the same
> provenance discipline applied to the regulation corpus. The **LG Polymers
> Vizag styrene leak of May 2020** (12 dead, workers asleep near a leaking tank
> because shift scheduling and sensor monitoring were separate systems) is a
> fully documented case of the identical pattern, and is retained as
> corroborating evidence rather than replaced.

The failure this project is built against, in either case: not missing data, but
data present and unacted upon.
