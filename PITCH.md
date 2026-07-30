# Sentinel-Gemma — the story to tell

Speaking notes. Roughly four minutes. The arc is: *we tried to give an agent
authority, discovered it couldn't be trusted with it, and built the thing that
makes it safe anyway.*

---

## 1. Open with the detector that isn't lying

> "A gas detector reading 4 %LEL in a steel plant says **safe**. And it's right —
> about the only question it was ever asked.
>
> It doesn't know a hot-work permit is open twelve metres away. It doesn't know
> maintenance just disturbed the ventilation. It doesn't know the shift is
> changing over and nine people are inside that zone.
>
> Nobody dies from one reading going out of range. They die from a *combination*
> where every individual reading looked fine."

That's the problem. Not missing sensors — a missing layer between them.

## 2. What we walked in with

We had a compound-risk forecaster: LightGBM across three horizons, SHAP for
attribution, a deterministic interlock engine, and retrieval over OISD-STD-105,
the Factories Act and DGMS circulars. Against classic SCADA alarm logic it caught
**100% of incidents versus 66.7%**, and cut false alarms on safe zones from
**51.4% to 4%**.

> "So it could *predict*. And it could *stop* work. What it couldn't do was
> **act**, or explain itself to the person holding the radio at 3am."

That's the gap Gemma fills.

## 3. The wall — say this plainly, it's the best part

> "Our plan was native Gemma function calling. So we tried it. And Ollama told us:
>
> `gemma3:latest does not support tools`
>
> Gemma 3 has no tool-calling template. The feature our architecture was built
> around does not exist."

Pause here. Then the reframe:

> "Which forced a better question. Everyone's demo answers *'can the model call a
> function?'* We had to answer a harder one: **'who is accountable when it calls
> the wrong one?'**"

## 4. Then we watched what it actually did

We had Gemma propose actions as JSON with the schema constraining the output. Every
response was structurally perfect. And:

| It returned | Reality |
|---|---|
| `permit_id: "HOT-WORK-4-23"` | Our system issues no permit numbers. Invented. |
| `muster_point: "Docking Bay Alpha"` | No such location in the plant. Invented. |
| gas at 1.78 %LEL is *"above the LEL threshold"* | It's **below** a 5.0 limit. It misread the unit. |
| `trigger_zone_alarm` × 3 in one plan | One physical alarm, logged three times. |
| Cited HAZWOPER | Not in our corpus. Hallucinated a standard. |

> "Valid JSON every time. Wrong content every time. Constrained decoding fixes
> shape — it knows nothing about meaning.
>
> And the worst one: an **invented assembly point inside an evacuation order.**
> That's not a bad answer. That's people walking to a place that doesn't exist."

## 5. So we built the gate

```
Gemma proposes → arguments coerced → authorised against the
                                     deterministic verdict → executed or refused
```

Three rules worth naming out loud:

- **`veto_permit` requires an interlock rejection.** A permit is revoked by the
  rule engine, never by a language model.
- **Identifiers never come from the model.** Zone IDs, permit references, muster
  points come from plant records.
- **Confidence is displayed and never acted on.** It returned 0.95 on a zone the
  rule engine had already cleared.

> "Gemma widens what this system can **do**. It never widens what it's allowed to
> **decide**."

## 6. The honest twist — this lands well

> "Five defects. Three were Gemma's. **Two were ours.**
>
> Our alias matcher couldn't connect `severity` to `alarm_level` — so a plan
> saying *Critical* fell through to a default and **silently downgraded an alarm
> the agent asked to raise.** Worse than a crash: it looks like success in every
> log.
>
> And our own guard corrupted a value Gemma got *right* — it proposed `BLF-2`, and
> our zone protection overwrote it with the display name. The thing built to
> prevent a wrong-zone action was causing one."

Every one has a regression test replaying the real malformed output. 223 tests pass.

## 7. Land it on the screen

Point at the Containment Tool Stream:

> "Green rows are what the agent did, autonomously. Amber rows are what it wanted
> to do and was refused — with the reason.
>
> Most agent demos hide that panel. It's the only one that matters. **A refused
> action is the proof the gate works.**"

Close:

> "It runs on Gemma 3, 4B, entirely on this laptop. No cloud call, no telemetry
> leaving the site — which is the precondition for this ever running in a real
> refinery. Unplug the network and it keeps working."

---

## If a judge asks

**"Isn't a 4B model too weak for safety work?"**
That's the design premise, not an objection. We assume it's unreliable and put
auditable logic between it and the plant. A bigger model would still need the gate
— it would just fail less obviously, which is worse.

**"Where's the memory across conversations?"**
We don't have it. State lives within one graph invocation. We flagged that as a
gap rather than claim a checkpointer we didn't build.

**"Why not native function calling?"**
Not available for Gemma 3 on Ollama — the API rejects it. We can show you the
error. Schema-constrained proposals plus a gate turned out to be the better
architecture for a system that can stop work.

**"Isn't 40 seconds slow?"**
Generation is the whole cost — measured 10.7 tok/s CPU-bound, roughly 10× faster
with the model in VRAM. It's why there are three Gemma nodes and not five, and why
the schemas are tight. Prompt tokens are nearly free; output tokens are the budget.

**"What if Gemma is down?"**
Every node records its own absence instead of fabricating output, and the graph
still completes. The forecaster, rule engine and interlocks don't depend on it. A
safety system must degrade, never disappear.

---

## Demo running order

The backend is frozen at **plant minute 70** so nothing drifts mid-pitch. Two
zones give you both beats on one screen:

1. **COB-B — 99% risk, gas 16.15 %LEL, hot work active, 9 crew.**
   Above the hot-work limit, so the interlocks reject the permit and
   `veto_permit` **executes**. This is "the agent acts."
2. **BLF-2 — 83% risk, gas 1.78 %LEL, hot work active, 8 crew.**
   Below the limit, so the permit is not rejected — and `veto_permit` gets
   **refused**, which is when the self-correction node runs. This is "the agent
   is stopped."

Run COB-B first, then BLF-2. The contrast is the whole argument.

Warm the model with one throwaway run before you present — Ollama evicts idle
models and the ~35s reload otherwise lands on your first demo node.
