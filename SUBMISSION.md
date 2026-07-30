# Sentinel-Gemma

**Track:** Agents on a Mission
**Team:** Sentinel-Gemma

---

## Problem

A combustible-gas detector reading 4 %LEL in a steel plant reports **safe**, and it is correct about the only question it was asked. It does not know a hot-work permit is open twelve metres away, that maintenance just disturbed ventilation, that the shift is mid-changeover, or that nine people are standing in the zone. Plant operators and shift in-charges die from that *combination*, where every individual reading looked acceptable — and the second failure mode compounds it: fixed-threshold alarms trip on roughly half of all quiet shifts, so the alarms get muted. Indian heavy industry does not lack sensors; it lacks a layer that connects them and then does something about what it finds.

---

## Solution

Sentinel-Gemma is an autonomous safety console. A background loop watches every zone in the plant continuously — no operator selects anything — and when a zone's compound risk crosses the escalation threshold it dispatches a nine-node agent chain against it. Deterministic nodes fuse the sensor signals and settle the hot-work permit verdict; retrieval establishes what the governing standard requires; then a Gemma agent proposes containment actions (revoke the permit, raise the zone alarm, purge ventilation, dispatch a response team). Every proposal passes a deterministic authorisation gate before anything executes, a second Gemma pass audits whatever the gate refused, and a third turns the model's risk drivers into a briefing a shift in-charge can act on. The operator watches the chain animate layer by layer and sees both what the agent did and what it was stopped from doing.

---

## How Gemma Is Used

- **Model variant:** Gemma 3 4B instruction-tuned — `gemma3:latest`, Q4_K_M, 3.34 GB.
- **How it's used:** Agent with schema-constrained tool proposals, plus RAG-grounded prose. Three of the nine graph nodes are Gemma: a containment planner, a self-reflection pass over its own refused proposals, and an advisory translator over SHAP attributions. The same model also writes the compliance answer and the draft regulatory notification.
- **Why this variant:** It fits in VRAM on a demo laptop, which is the whole point — plant telemetry never leaves the site, and the console keeps working with the network unplugged. A 4B model is also the honest test of the architecture: if the gate can make a small unreliable model safe to act through, it makes any model safe to act through.
- **Customization:** No fine-tuning. What was engineered instead:
  - **Structured decoding.** Ollama's `format` parameter is given a JSON Schema per node, with the tool name as an `enum` generated from the tool registry — so the model cannot emit a tool that does not exist.
  - **Four tools wired up:** `veto_permit`, `trigger_zone_alarm`, `adjust_ventilation`, `dispatch_response_team`. The prompt catalogue is generated from the registry, so it cannot advertise a signature the code does not have.
  - **Prompt carries the arithmetic.** `%LEL` is a percentage *of* the lower explosive limit; given a bare `1.78 %LEL` against a 5.0 limit the model wrote "above the LEL threshold". The telemetry block now states the convention, makes the comparison, and reads the threshold from the rule engine.
  - **Agent design.** Gemma runs only after the permit verdict is settled deterministically, and its self-reported confidence is displayed but never gated on — it returned 0.95 on a zone the rule engine had cleared.

> **Important:** Gemma 3 has **no tool-calling template in Ollama** — posting `tools` returns `"gemma3:latest does not support tools"`. So it proposes actions as JSON and a deterministic gate executes them. `veto_permit` requires an interlock rejection: a permit is revoked by the rule engine, never by a language model.

---

## Architecture

```
SCADA · gas · permits · maintenance · roster
                  │
                  ▼
   ┌──────────────────────────────────┐
   │ LightGBM forecaster 15/30/60 min │   23 features, monotone on gas
   │ SHAP · IsolationForest + PCA     │   ML — not Gemma
   └──────────────────────────────────┘
                  │  risk · lead time · drivers
                  ▼
   ┌──────────────────────────────────┐
   │ AUTONOMOUS ORCHESTRATOR          │   scans every zone every 5s,
   │ picks the zone, dispatches       │   dispatches above 50% risk
   └──────────────────────────────────┘
                  │
      ┌───────────┴────────────────────────────────┐
      ▼ SENSOR LAYER (deterministic)               │
   risk_monitor → permit_intelligence ── verdict ──┤
      ▼ RETRIEVAL LAYER                            │
   compliance  (TF-IDF over OISD-STD-105,          │
               Factories Act 1948, DGMS)           │
      ▼ GEMMA LAYER                                │
   gemma_containment → [AUTHORISATION GATE] ───────┤
   gemma_reflection · gemma_advisor                │
      ▼ RESPONSE LAYER                             │
   emergency_orchestrator · advisory ──────────────┘
                  │
                  ▼
        Operator console (live chain animation)
```

**Tech stack:** Python 3.11, FastAPI, LangGraph, LightGBM, SHAP, scikit-learn. Inference runtime **Ollama** (local, no cloud call). Frontend React 19 + TanStack Start + TailwindCSS v4 + Three.js + Framer Motion. Deployment target: an operator workstation on the plant network.

---

## Results / Demo

**What it does well.** Held-out evaluation over 600 replayed episodes (126 incident, 251 safe, 223 near-miss excluded from false-alarm denominators), against a fair implementation of classic SCADA alarm logic (`gas ≥ 10 %LEL`) as the control:

| Metric | Baseline | Sentinel-Gemma |
|---|---:|---:|
| Incident detection rate | 66.7% | **100.0%** |
| False-alarm rate, safe zones | 51.4% | **4.0%** |
| Nuisance alarm-minutes | 366 | **11** |
| Matched lead time | **34.8 min** | 15.7 min |

**42 incidents the baseline missed entirely** were caught by the compound model. The baseline wins lead time by ~19 minutes and we report it: it buys that by tripping on half of all safe episodes.

**Concrete example — a real autonomous run.** The orchestrator selected Coke Oven Battery B (COB-B) unprompted at 99% risk, gas 16.15 %LEL, hot work active, 9 crew. Permit `REJECTED`, priority `CRITICAL`, two interlocks tripped. Gemma proposed three actions, all executed — and two of its arguments were fabricated and replaced before execution:

```
EXEC  veto_permit          proposed permit_id  "COB-B-HW-20241027"   ← no such numbering exists
                           executed as         "HOTWORK-COB-B"
EXEC  trigger_zone_alarm   LEVEL_3
EXEC  dispatch_response_team
                           proposed muster_point "Loading Dock Alpha"  ← no such location
                           executed as           "primary assembly point"
```

It got the zone, the alarm level and the reasoning right — and invented a permit number and an assembly point in the same response. That is what the gate is for.

**Measured performance.** 10.7 tok/s generation, ~84 tok/s prompt eval, CPU-bound. Containment node 76.8 s for 254 tokens; reflection 26 s; a full emergency chain 148–190 s end to end. Roughly 10× faster with the model resident in VRAM. Model size 3.34 GB at Q4_K_M.

**Test coverage.** 223 tests pass. 22 target the authorisation gate specifically, each replaying real malformed model output: invented permit IDs and muster points, a `severity: "Critical"` that our own alias matcher once silently downgraded to `LEVEL_2`, duplicate alarms, unregistered tools, and an unreachable model.

- **Demo video:** *[link — record the /orchestration page at plant minute 70]*
- **Live demo (if hosted):** *[link, or the clonable notebook]*
- **Screenshots:** *[AI Orchestration page — sensor row, live chain, containment stream]*

---

## Links

- **GitHub repo:** https://github.com/Ganesh-0509/Sentinel-gemma
- **Datasets used:**
  - Plant telemetry — **synthetic**, generated by `backend/sim/simulator.py` (seeded, reproducible). No proprietary plant data.
  - Regulation corpus — OISD-STD-105, Factories Act 1948, DGMS circulars. Public statutes and standards; provenance and licence per document in `data/regulations/README.md`.
  - Site boundary — OpenStreetMap way 395219953 (RINL Visakhapatnam), ODbL.
  - PPE vision (optional, off by default) — SH17 dataset. Weights **not** redistributed in this repo; its licence does not permit it.
- **Demo:** *[link]*
- **License for this project:** see `LICENSE` in the repository.

---

## Acknowledgments

- **Google DeepMind** for Gemma 3, and the open weights that make local inference on a laptop possible at all.
- **Ollama** for the local runtime, and specifically for schema-constrained decoding via `format` — which is what made a tool-calling architecture possible on a model with no tool-calling template.
- **OISD**, the **Directorate General of Mines Safety** and the **Factories Act 1948** for the publicly available standards the compliance layer is grounded in.
- **OpenStreetMap** contributors for the RINL Visakhapatnam site boundary (ODbL).
- **LangGraph**, **LightGBM** and **SHAP** — the orchestration, forecasting and attribution layers Gemma consumes.
- **GDG VIT Chennai** for running the event.

**A note on honesty:** the plant is a simulator, not live SCADA. There is no cross-conversation memory — state lives within one graph invocation. Permit references are derived from the zone rather than looked up in a permit-management system. These are stated here rather than left to be discovered.
