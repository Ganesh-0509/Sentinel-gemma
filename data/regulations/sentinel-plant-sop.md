---
title: Sentinel-Gemma Plant Safety Operating Procedure
standard: Sentinel-Gemma SOP
provenance: OFFICIAL
kind: INTERNAL
---

## Scope and Standing of This Procedure

This is the plant's own operating procedure for the Sentinel-Gemma compound-risk system.
It is authoritative for how the system behaves and how operators are expected to act
on its output. It does not restate, replace, or reinterpret any statutory or industry
standard; where this procedure and a regulation differ, the regulation governs.

## The Safety Contract

The machine-learning layer may escalate or reject work. It can never approve work
that the deterministic gas and oxygen interlocks have rejected.

Anything that can stop or clear work is plain, auditable, deterministic logic. Model
outputs move a decision in one direction only: `APPROVED → CONDITIONAL → REJECTED`.
There is no code path by which a probability upgrades a decision.

If every language-model tier is unavailable, the interlocks still enforce. Safety
degrades gracefully; it does not fail silently.

## Deterministic Interlocks

The following conditions are evaluated without reference to any model:

- **Hot work** is rejected when combustible gas reaches or exceeds the hot-work
  limit configured for the site.
- **Confined space entry** is rejected when combustible gas reaches or exceeds the
  entry limit, or when oxygen falls outside the breathable band in either direction.
- **All other permit types** are rejected at the general combustible gas limit.
- **Standing interlocks** apply independently of any permit request: active hot work
  with gas above the hot-work limit triggers suspension, and gas above the general
  limit with workers present triggers evacuation.

These thresholds are configuration, not model output. Changing them is a controlled
change requiring sign-off by the plant safety authority.

## Compound Risk and the Advisory Band

A permit may be marked CONDITIONAL rather than rejected where gas is below the hard
limit but the surrounding conditions are adverse — gas present and rising while
maintenance is active near an authorised ignition source.

CONDITIONAL means the issuing authority must satisfy themselves of the conditions
before work proceeds. It is a prompt for human judgement, not an approval.

## Escalation by the Compound Risk Model

Where the compound-risk forecast is high and the deterministic verdict is APPROVED,
the decision is downgraded to CONDITIONAL. Where the forecast is very high, the
decision is downgraded to REJECTED.

The model's role is to catch the case the fixed thresholds cannot see: a point sensor
reading within limits while the true zone concentration is higher, because disturbed
ventilation is attenuating the reading at the detector.

## Why Shift Context Is Excluded From the Hazard Model

The forecaster is trained on observable process and operational features. Shift and
roster features — night shift, changeover, staffing — are deliberately excluded from
its inputs.

Including them taught the model that a hazard occurring on day shift was less likely
to become an incident, because a human would probably catch it. That is true, and it
is exactly the wrong thing for a hazard model to learn: it suppresses the alert
precisely when the alert is doing its job.

Shift context is applied instead at the decision layer, where it raises the urgency
and priority of an alert without ever lowering the assessed hazard.

## Alert Prioritisation

Alert priority is the product of assessed risk, the number of people exposed, the
urgency modifiers for night shift and changeover, and the criticality of the asset.

Hazard, consequence and urgency are separate layers. A hazard with nobody exposed is
still a hazard and is still reported; it simply does not outrank a hazard with a crew
in the zone.

## Operator Response to a Critical Alert

On a critical compound-risk alert the operator is expected to:

1. Treat the alert as valid until positively disproved by a fresh gas test at the
   work face — not at the fixed detector.
2. Suspend any authorised hot work in the affected zone.
3. Account for all personnel in the zone.
4. Escalate to the shift-in-charge and the plant safety authority.
5. Preserve the sensor evidence window for investigation.

An alert that is dismissed without a fresh gas test at the work face is recorded as
an unverified dismissal and is reviewed.

## Explainability and Audit

Every alert carries the feature attributions that produced it. Every permit decision
carries its reasons and the interlock that produced them.

The system records what it saw, what it concluded, and what action followed. This
record is intended to survive scrutiny after an incident, including the case where
the system was right and was overruled.
