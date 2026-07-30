# Sentinel-Gemma — Track 1 Alignment & Pitch Notes

> **Event:** Build with Gemma — GDG VIT Chennai
> **Track:** Agents on a Mission
> **Model:** Gemma 3 (`gemma3:latest`, 4B) via Ollama, running locally
> **Repository:** https://github.com/Ganesh-0509/Sentinel-gemma

Every claim below is checkable in the repository. Nothing here is aspirational —
this document was rewritten after the build, against what the code does.

---

## 1. Track mandate, line by line

> *"Create intelligent, action-oriented systems powered by Gemma that can plan,
> reason, and complete tasks with minimal human intervention. This track focuses
> on building agents that integrate with external tools, manage memory across
> conversations, and execute multi-step workflows to solve complex problems in
> real time."*

| Requirement | How we meet it | Where to look |
|---|---|---|
| **Action-oriented** | Gemma proposes containment actions that execute against the plant: permit revocation, zone alarms, ventilation purge, team dispatch | `backend/agents/tools.py` |
| **Plan & reason** | 9-node LangGraph state machine, 3 nodes driven by Gemma with schema-constrained reasoning | `backend/agents/graph.py`, `gemma_nodes.py` |
| **Minimal human intervention** | Actions execute autonomously once the deterministic layer has escalated; no operator confirmation step | `tools.execute_plan` |
| **External tool integration** | 4 registered tools with declared signatures, plus SCADA telemetry, a LightGBM forecaster, SHAP, and TF-IDF retrieval over three standards | `tools.REGISTRY` |
| **Self-correction** | A reflection node reads its own refused proposals and revises | `gemma_nodes.gemma_reflection` |
| **Multi-step, real time** | Risk → permit interlocks → compliance RAG → containment → reflection → notification, in one graph invocation | `POST /api/v1/workflow/run/{zone}` |

**Honest gap.** We do not persist memory across conversations. State is carried
through a single graph invocation, and the plant clock replays a precomputed
240-minute episode. Claiming a checkpointed cross-shift memory buffer would be
inventing a feature — so we do not.

---

## 2. The argument that should win this

Most agent demos answer *"can the model call a tool?"* We answer a harder
question: *"who is accountable when it calls the wrong one?"*

We set out to use native Gemma function calling. It does not exist on this path —
Ollama returns `"gemma3:latest does not support tools"`. So Gemma proposes actions
as JSON constrained by Ollama's `format` parameter, and a deterministic gate
authorises them:

```
Gemma proposes ─▶ coerce arguments ─▶ authorise against the
                                      deterministic verdict ─▶ execute or refuse
```

The gate is not defensive decoration. `format` constrains shape and knows nothing
about meaning, and the model demonstrably exploits the gap. All of these are real
`gemma3:latest` output with decoding already constrained:

- named arguments no tool declares (`rate`, `direction`, `severity`)
- a permit number, `HOT-WORK-4-23`, for a system that issues none
- a muster point, `Docking Bay Alpha`, for a plant with no such location
- the same alarm proposed three times in one plan
- a citation to HAZWOPER, absent from our corpus

Shape was perfect. Content was not. **`veto_permit` requires an interlock
rejection — a permit is revoked by the rule engine, never by a language model.**
Self-reported confidence is displayed and never gated on; the model returned 0.95
on a zone the rule engine had cleared.

Refusals render as prominently as executions in the console. That is the demo
moment: the agent acts autonomously, *and* you can see exactly where it was
stopped and why.

---

## 3. Rubric mapping

### Gemma Integration — 30%

Gemma is the only reasoning engine in the system. Three agent nodes and all
console prose — the compliance answer and the regulatory notification — run on
`gemma3:latest`. Prose previously ran on Gemini with a `llama3.1:8b` fallback;
both were removed so the console is one model family. Cloud now requires an
explicit `SENTINEL_LLM_PREFER=gemini`.

Structured reasoning uses Ollama's JSON-Schema-constrained decoding, with the
tool `enum` generated from the registry so the prompt cannot advertise a tool that
does not exist.

### Innovation & Impact — 30%

Compound hazard blind spots: a gas detector at 4% LEL reports "safe" and is
correct about the only question it was asked. Measured against classic SCADA alarm
logic over 600 replayed episodes — detection 66.7% → **100%**, false alarms on
safe zones 51.4% → **4.0%**, nuisance alarm-minutes 366 → **11**.

The baseline beats us on lead time by ~19 minutes and we report that: it buys the
warning by tripping on half of all safe episodes.

### Functionality — 20%

217 tests pass, 18 covering the gate specifically — each replaying real malformed
model output. Full stack runs: FastAPI backend, 12-route operator console, live
plant clock. A complete emergency run was executed end to end against BLF-2.

### Presentation & Writeup — 20%

1,306 words, under the 1,500 limit. Leads with the gate rather than a feature
list, and includes the three bugs the sprint cost us — including one where our own
guard corrupted a value Gemma had correct.

---

## 4. Scope decisions

**Local-only inference, deliberately.** Plant telemetry never leaves the site,
which is the precondition for deploying any of this in a refinery. It also means
venue wifi cannot kill the demo. This is not a Track 3 hedge — it is what makes
the Track 1 story deployable.

**Deterministic core kept, not replaced.** The temptation was to let Gemma own the
risk score and the permit verdict. That would have discarded the monotonicity
guarantee (`tests/test_model_monotonicity.py`) that is the strongest engineering
proof in the project, and replaced auditable logic with a 4B model's opinion.
Gemma widens what the system can *do*, never what it is allowed to *decide*.

**Degradation over disappearance.** If Gemma is unreachable, every node records
its absence instead of fabricating output, and the graph completes. The
forecaster, rule engine and interlocks do not depend on it.

---

## 5. Demo running order

1. **Header** — model badge reads `gemma3:latest · local`.
2. **Command Center** — pick the zone above the escalation threshold.
3. **Agent Workflow → Run** — walk the trace as it fills: deterministic verdict
   first, then Gemma's proposal.
4. **Containment Tool Stream** — the payoff. Executed actions in green, refusals in
   amber with the reason, and the corrected-argument markers.
5. **Agent Reasoning** — confidence beside a refusal, with the note that
   confidence is not an input to the gate.
6. **Inference Telemetry** — per-node latency, and `no telemetry left this machine`.

Pick a zone whose permit is **not** rejected but whose priority is CRITICAL: that
is where `veto_permit` gets withheld and the reflection node actually runs.

Generation measures 10.7 tok/s CPU-bound — a full run took 180s on that box. With
the model resident in VRAM it is roughly an order of magnitude faster. Warm the
model with one throwaway run before presenting; Ollama evicts an idle model and
the reload lands on whichever node runs first.
