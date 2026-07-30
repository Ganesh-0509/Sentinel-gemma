# Sentinel-Gemma: Autonomous Compound-Hazard Containment with a Gated Gemma Agent

**Subtitle:** A local Gemma agent that revokes unsafe hot-work permits and evacuates zones minutes before any single gas detector trips — and a deterministic gate that refuses the agent when it overreaches.

---

## Metadata

| Field | Value |
|---|---|
| **Track** | **Agents on a Mission** *(selected in the submission form)* |
| **Model** | Gemma 3 — `gemma3:latest` (4B, Q4_K_M) served locally by Ollama 0.32.5 |
| **Public repository** | `https://github.com/Ganesh-0509/Sentinel-gemma` |
| **Live demo** | Operator console (`bun run dev` → `:8080`) + clonable notebook driving the graph headless |
| **Architecture diagram** | In-body below and in `README.md` § *The Gemma agent layer* |

> **Note on model version.** The event permits any Gemma model. We ran **Gemma 3 4B locally** rather than Gemma 4 in the cloud, because the entire value proposition is that plant telemetry never leaves the site. We state the version explicitly rather than letting "Gemma" imply the newest release — every measurement below is from Gemma 3.

---

## 1. Problem Statement

Indian heavy industry does not lack sensors; it lacks a layer connecting them. A combustible-gas detector reading 4 %LEL reports **safe**, and it is correct about the only question it was asked. It does not know a hot-work permit is open twelve metres away, that maintenance just disturbed ventilation, that the shift is mid-changeover, or that nine people are inside the zone.

Fatalities come from that *combination*, where every individual reading looked acceptable. The second failure mode is alarm fatigue: fixed-threshold alarms trip on roughly half of all quiet shifts, so operators mute them.

## 2. Solution Summary

Sentinel-Gemma sits above existing plant systems, fuses their signals into a forward-looking explainable forecast, and then **acts on it**. A nine-node LangGraph workflow scores compound risk, evaluates a hot-work permit against live conditions, retrieves the governing regulation, and hands the settled verdict to a Gemma agent that proposes containment: revoke the permit, raise the alarm, purge ventilation, dispatch a team. Every proposal passes a deterministic authorisation gate before anything executes, and refusals are shown to the operator as prominently as executions.

## 3. Architecture — How Gemma Is Specifically Used

```
SCADA · gas · permits · maintenance · roster
        │
        ▼  23 hazard features (5 shift features routed away — see §5)
┌───────────────────────────────────────────────┐
│ LightGBM forecaster  15/30/60 min horizons    │  ML, not Gemma
│ monotone constraints on gas                   │
│ SHAP attribution · IsolationForest + PCA      │
└───────────────────────────────────────────────┘
        │  risk, lead time, drivers, anomaly score
        ▼
┌───────────────────────────────────────────────┐
│ risk_monitor          DETERMINISTIC           │
│ permit_intelligence   DETERMINISTIC ← verdict │
│ compliance            TF-IDF RAG + Gemma prose│
└───────────────────────────────────────────────┘
        │  verdict + interlocks + regulation
        ▼
┌───────────────────────────────────────────────┐
│ gemma_containment  ── proposes tool calls     │  GEMMA
│        ▼ AUTHORISATION GATE (deterministic)   │
│ gemma_reflection   ── audits own refusals     │  GEMMA
│ gemma_advisor      ── SHAP → operator English │  GEMMA
└───────────────────────────────────────────────┘
```

**What Gemma receives.** A telemetry block naming the zone and its identifier; gas in %LEL *with the comparison to the 5.0 %LEL hot-work limit already made* and headroom stated; trend with direction in words; compound risk; predicted time to threshold; crew count; hot-work, maintenance, changeover and night-shift flags; the electrical area classification labelled *not a location*; the SHAP driver list; the settled permit verdict; and tripped interlocks. The tool catalogue is generated from the registry, so the prompt cannot advertise a tool that does not exist.

**Tools Gemma can call.** `veto_permit` (revoke a hot-work permit), `trigger_zone_alarm` (LEVEL_1–3), `adjust_ventilation` (target CFM), `dispatch_response_team` (team + muster point).

**How Gemma emits and how output is consumed.** Gemma 3 has **no tool-calling template in Ollama** — posting `tools` returns `"gemma3:latest does not support tools"`. So the agent emits a JSON containment plan under Ollama's `format` parameter, which constrains decoding to a supplied JSON Schema with the tool name as an `enum` over the registry. `execute_plan` then coerces arguments to declared signatures, collapses duplicates, authorises each call, and returns one receipt per proposal — executed or refused — which the API surfaces and the console renders.

**What Gemma does not control.** It cannot set the risk score, cannot decide the permit verdict, and cannot execute any restrictive action the deterministic layer has not escalated. `veto_permit` additionally requires an interlock rejection: a permit is revoked by the rule engine, never by a language model. Zone identifiers, permit references and muster points are supplied by the workflow, never accepted from the model. Gemma's self-reported confidence is displayed and is **not** an input to the gate — it returned 0.95 on a zone the rule engine had cleared.

**Relationship to the other models.** Gemma does not orchestrate the ML stack; LangGraph does. Gemma *consumes* LightGBM risk, SHAP attributions, IsolationForest anomaly scores and TF-IDF retrieval, and *proposes* actions over them. That direction keeps the monotonicity guarantee and the interlock logic outside the model's reach.

## 4. Challenges Overcome in the Sprint

**Native function calling did not exist.** Our design assumed it; Ollama rejected it for Gemma 3. Rather than switch to a cloud model — breaking the local-only premise — we inverted the pattern to propose-then-authorise. Defensible because it yields a stronger safety property: proposal and execution become separately auditable.

**The model fabricated plant identifiers.** It returned `permit_id: "COB-B-HW-20241027"` for a system that issues no permit numbers, and `muster_point: "Loading Dock Alpha"` for a plant with no such location — inside an evacuation order. Fix: caller-authoritative arguments; the model's values are recorded for display but discarded before execution.

**The model misread the unit.** `%LEL` is a percentage *of* the lower explosive limit. Given `1.78 %LEL` against a 5.0 limit it wrote "above the LEL threshold" and warned of imminent explosion. Fix: the prompt states the convention, makes the comparison itself, and reads the threshold from the rule engine so it cannot drift.

**Two defects were ours.** Our alias matcher could not relate `severity` to `alarm_level`, so a plan reading "Critical" fell to a `LEVEL_2` default — **silently downgrading an alarm the agent asked to raise**, which looks like success in every log. Separately our own zone guard overwrote a correctly proposed `BLF-2` with the display name; the protection against wrong-zone actions was causing one. Defaults now fail upward.

**Descoped deliberately.** Cross-conversation memory (§7). Five Gemma nodes cut to three, because at 10.7 tok/s each node spends an operator's attention. Six planned UI components cut to four panels reusing the existing twelve routes.

## 5. Why These Technical Choices Were Right

**Local 4B over cloud.** Plant telemetry never leaves the site — the precondition for refinery deployment — and the demo survives venue wifi. Cloud requires an explicit `SENTINEL_LLM_PREFER=gemini`, so a stray API key cannot silently move inference off-site.

**Schema-constrained decoding over prompt-and-parse.** JSON is valid by construction, and `enum` on the tool name makes an unregistered tool undecodable.

**A gate rather than a better prompt.** Prompting reduced the error rate; it did not eliminate it. The gate converts a probabilistic failure into a deterministic refusal.

**Three nodes, low token caps.** Prompt eval runs ~84 tok/s against 10.7 tok/s generation — prompt length is nearly free, output length is the entire latency budget.

**Monotone constraints retained.** Letting Gemma own the risk score would have discarded the tested property that more gas can never mean less risk.

## 6. Validation / Evidence

**Held-out evaluation**, 600 replayed episodes (126 incident, 251 safe, 223 near-miss excluded from false-alarm denominators), against a fair implementation of classic SCADA logic (`gas ≥ 10 %LEL`) as the control:

| Metric | Baseline | Sentinel-Gemma |
|---|---:|---:|
| Incident detection rate | 66.7% | **100.0%** |
| False-alarm rate, safe zones | 51.4% | **4.0%** |
| Nuisance alarm-minutes | 366 | **11** |
| Matched lead time | **34.8 min** | 15.7 min |

**42 incidents the baseline missed entirely** were caught by the compound model. `gas_monotonicity_verified: true` in `reports/scoreboard.json`.

**Test suite:** 223 tests pass; 22 cover the authorisation gate, each replaying real malformed model output — invented permit IDs and muster points, the `severity` downgrade, duplicate alarms, unregistered tools, an unreachable model.

**Measured inference** (CPU-bound): 10.7 tok/s generation, ~84 tok/s prompt eval. Containment node 76.8 s for 254 tokens; reflection 26 s; full emergency workflow 190 s end to end. Roughly an order of magnitude faster with the model resident in VRAM.

**Verified end-to-end run** (COB-B, gas 16.15 %LEL, hot work active, 9 crew): permit `REJECTED`, priority `CRITICAL`, two interlocks tripped, and `veto_permit`, `trigger_zone_alarm(LEVEL_3)` and `dispatch_response_team` all executed — with two fabricated identifiers caught in the same response.

## 7. Limitations & Honest Caveats

The plant is a **simulator replaying a precomputed 240-minute episode**, not live SCADA, so the evaluation is on simulated episodes. **There is no cross-conversation memory** — state lives within one graph invocation, and the track description asks for it. Permit references are *derived* from the zone, not looked up in a permit-management system. The reflection node once set its dispute flag inconsistently with its own prose, so the console renders that flag only when raised. Baseline lead time is **19 minutes better than ours**: it buys that by tripping on half of all safe episodes. The PPE vision layer is off by default and its weights are not redistributable. Latency figures are from a CPU-bound machine.

## 8. Why This Is a Strong Foundational Asset

The gate is the reusable artefact. `REGISTRY` is a dict of tool specs with declared signatures and an escalation flag: adding a plant actuator is one entry, and the prompt catalogue and JSON Schema regenerate from it. Swapping the model is one environment variable (`GEMMA_MODEL`), because inference is isolated behind `GemmaAgentClient.structured()` — a larger Gemma or a fine-tune drops in without touching safety logic. And every refusal is a labelled example of a small model reaching past its authority: the refusal log is exactly the corpus you would fine-tune on.

## 9. Closing

A gas detector that reads 4 %LEL is not broken — it is answering the only question it was asked; Sentinel-Gemma asks the harder one, acts on the answer autonomously, and can be trusted to because the plant, not the model, decides what it is allowed to do.
