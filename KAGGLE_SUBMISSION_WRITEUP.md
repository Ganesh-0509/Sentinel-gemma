# Sentinel-Gemma: An Agent That Proposes, and a Plant That Decides

**Track:** Agents on a Mission
**Model:** Gemma 3 (`gemma3:latest`, 4B) running locally via Ollama
**Repository:** https://github.com/Ganesh-0509/Sentinel-gemma

---

## The problem

Indian heavy industry does not lack sensors. It lacks a layer that connects them.

SCADA, gas detectors, permit-to-work systems, maintenance logs and shift rosters
all generate data, and all operate independently. So the condition that kills
people is rarely one reading out of range. It is a *combination*: combustible gas
rising while a hot-work permit is open, while maintenance has disturbed
ventilation, during a shift changeover, with a crew in the zone. Every individual
reading looks acceptable. A gas detector at 4% LEL reports "safe" and is correct
about the only question it was asked.

Two failure modes follow. **Compound hazard blind spots**, where no single sensor
owns the danger. And **alarm fatigue**, where fixed thresholds trip on half of all
quiet shifts, so operators learn to silence them — and then cross-referencing
multi-page standards under time pressure costs minutes nobody has.

## What we built on

Sentinel-Gemma extends a working compound-safety platform: a LightGBM forecaster
with monotonicity constraints across 15/30/60-minute horizons, SHAP attribution,
an IsolationForest anomaly channel, a deterministic interlock engine, and TF-IDF
retrieval over OISD-STD-105, the Factories Act 1948 and DGMS circulars.

Held-out evaluation over 600 replayed episodes, against a fair implementation of
classic SCADA alarm logic (`gas ≥ 10 %LEL`) as the control:

| Metric | Single-sensor baseline | Sentinel |
|---|---:|---:|
| Incident detection rate | 66.7% | **100.0%** |
| False-alarm rate on safe zones | 51.4% | **4.0%** |
| Nuisance alarm-minutes | 366 | **11** |
| Matched lead time | **34.8 min** | 15.7 min |

The baseline wins lead time by ~19 minutes, and we report that rather than hide
it: it buys the warning by tripping on half of all safe episodes. That is the
alarm-fatigue mode this project exists to remove.

## Where Gemma comes in

The platform could forecast and could veto. It could not *act*, and it could not
explain itself to the person holding the radio. That is the gap Gemma fills.

The safety graph now has nine nodes. Three are Gemma:

```
risk_monitor ──┬── below threshold ──▶ monitor_only ──▶ END
               │
               └─▶ permit_intelligence ──▶ compliance
                                              │
                   ┌──────────────────────────┴──────────┐
                   ▼                                     ▼
            gemma_containment                        advisory
                   │                                     │
            gemma_reflection                        gemma_advisor ──▶ END
                   │
            emergency_orchestrator ──▶ END
```

`gemma_containment` proposes containment actions. `gemma_reflection` reads its own
refused proposals and revises — and skips entirely when nothing was refused,
because a revision step that concludes the plan was fine costs twenty seconds and
teaches an operator to ignore the panel. `gemma_advisor` turns SHAP attributions
into a briefing that never says "SHAP", "feature" or "score". All prose in the
console — the compliance answer, the regulatory notification — runs on the same
local Gemma.

`risk_monitor` and `permit_intelligence` remain LLM-free. **The Gemma layer widens
what the system can autonomously do without widening what it is allowed to
decide.**

## The technical decision that shaped everything

We planned to use native Gemma function calling. It does not exist on this path.
Posting `tools` to Ollama's `/api/chat` returns:

```
"registry.ollama.ai/library/gemma3:latest does not support tools"
```

Gemma 3 has no tool-calling template in Ollama. So agents propose actions as JSON
constrained by Ollama's `format` parameter — which restricts decoding to a
supplied JSON Schema — and a deterministic gate decides what executes.

This turned out better than function calling would have been. On a system that can
stop work in a live plant, the useful question is not *can the model call a
function* but *who is accountable when it calls the wrong one*:

```
Gemma proposes ─▶ coerce arguments ─▶ authorise against the
                                      deterministic verdict ─▶ execute or refuse
```

Because `format` constrains shape and knows nothing about meaning. Every failure
below is real output from `gemma3:latest` with decoding already constrained —
valid JSON, wrong content:

| Gemma returned | The gate does |
|---|---|
| `rate: "Maximum"`, `direction: "Upward"` | Coerces to `target_cfm`, clamps to fan range |
| `severity: "Critical"` | Maps to `LEVEL_3`; unspecified levels fail **upward** |
| `permit_id: "HOT-WORK-4-23"` | Discards — nothing upstream issues permit numbers |
| `muster_point: "Docking Bay Alpha"` | Discards — no such location exists |
| `trigger_zone_alarm` ×3 in one plan | Collapses duplicates |
| Cited HAZWOPER | Not in the corpus; standards come from RAG, never the model |

Restrictive actions require the deterministic layer to have escalated.
`veto_permit` additionally requires an interlock rejection — a permit is revoked by
the rule engine, never by a language model. Ventilation is exempt, because purging
removes the hazard instead of restricting people.

The model's self-reported confidence is displayed and never gated on. It returned
0.95 on a zone the rule engine had cleared.

**Refusals are rendered as prominently as executions.** Hiding them would leave
the console claiming autonomous action while concealing the part that makes it
safe.

## What the sprint actually cost us

Three of our own bugs, each found by watching real model output rather than by
reading our code:

1. Our alias matcher could not relate `severity` to `alarm_level`, so a plan
   reading "Critical" fell through to a `LEVEL_2` default — **silently downgrading
   an alarm the agent had asked to raise.** Defaults now fail upward.
2. The model invented `permit_id: "HOT-WORK-4-23"`, and it reached the executed
   action and the audit trail. A fabricated reference in a record a statutory
   investigation will rely on is worse than an obviously derived one.
3. Our own guard corrupted a correct value: the workflow carries the zone label in
   `zone` and the identifier in `machine_id`, and the node read `zone` first — so
   a correctly proposed `BLF-2` became `Blast Furnace 2`. The substitution built
   to prevent a wrong-zone action was causing one.

Each has a regression test replaying the real malformed output. 18 tests cover the
gate; 217 pass overall.

## Latency, honestly

Generation is the entire cost. Measured: **10.7 tok/s** generation against ~84
tok/s prompt eval, with the model CPU-bound. Long prompts are nearly free, long
answers are not — which is why the schemas are tight, output caps are low, and
there are three Gemma nodes rather than five. A full emergency run took 180s on
that box; with the model resident in VRAM it drops by roughly an order of
magnitude.

Per-node telemetry separates model load from generation, because Ollama evicts an
idle model and charges the reload to whichever node runs next — which made one
43-token answer measure 0.7 tok/s against ~10 tok/s warm. Reporting them together
would have made the model look ten times slower than it is.

## Why local matters

Everything runs on the operator's machine. Plant telemetry never leaves the site,
which is the actual precondition for any of this being deployable in a refinery.
The cloud tier now requires an explicit `SENTINEL_LLM_PREFER=gemini`: a stray API
key in the environment should not be able to move inference off-site during a
demo — or a shift.

If Gemma is unreachable, every node records its own absence rather than
fabricating output, and the graph still completes. The forecaster, the rule engine
and the interlocks do not depend on it. A safety system must degrade, never
disappear.

## What we would do next

Stream node output so a 40-second run shows progress instead of a spinner. Ground
the tool catalogue in a real permit-management system so `permit_id` is a lookup
rather than a derivation. And run the gate's refusal log as a dataset — every
refusal is a labelled example of a 4B model reaching past its authority, which is
exactly the corpus you would fine-tune on.

---

*The gate is the contribution. An agent that can act in a plant is only as good as
the thing standing between its proposal and the plant.*
