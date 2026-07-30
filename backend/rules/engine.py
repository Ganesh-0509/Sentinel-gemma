"""Deterministic safety rule engine -- the hard guarantees.

Design principle: **we ML the predictions, but we hard-code the guarantees.**
A probabilistic model must never be allowed to *approve* a hot-work permit over a
gas-air mixture. These interlocks are plain, auditable boolean logic derived from
OISD-STD-105 (Work Permit System) gas-testing limits -- exactly the kind of rule a
factory inspector can read and sign off on.

Thresholds are expressed in % LEL / % O2 / ppm, matching OISD gas-testing units.
They are configurable so a plant can map them to its own permit conditions.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# --- OISD-STD-105-aligned limits (configurable per site) --------------------
HOT_WORK_MAX_LEL = 5.0        # combustible gas must be well below the explosive limit
GENERAL_MAX_LEL = 10.0        # first-alarm level for any occupied work
CONFINED_SPACE_MAX_LEL = 5.0
O2_MIN_PCT = 19.5             # oxygen-deficient below this
O2_MAX_PCT = 23.5            # oxygen-enriched (fire risk) above this
COMPOUND_WATCH_LEL = 3.0      # below the hard limit but worth watching if trending up

# --- Trend projection -------------------------------------------------------
#
# A level check alone answers "is it safe *now*", which is the wrong question for
# a permit: a permit authorises work over a *window*. Gas at 4.2 %LEL climbing
# 0.36 %LEL/min is below the 5.0 hot-work limit and crosses it in two minutes,
# and a level-only interlock happily approves it. So the limit is projected
# forward at the observed trend and the decision is made against the projection.
#
# Still deterministic: real reading, real slope, real arithmetic. No model.
TREND_WATCH_MIN = 15.0        # projected to cross within this -> CONDITIONAL
TREND_IMMINENT_MIN = 5.0      # projected to cross within this -> REJECTED

# Ordering used to guarantee a decision can only ever be tightened.
_STRICTNESS = {"APPROVED": 0, "CONDITIONAL": 1, "REJECTED": 2}


def _tighten(current: str, proposed: str) -> str:
    """Return the stricter of two verdicts.

    Every rule below routes through this rather than assigning `status`
    directly, so no rule ordering -- present or future -- can accidentally
    downgrade a rejection into an approval.
    """
    return proposed if _STRICTNESS[proposed] > _STRICTNESS[current] else current


def minutes_to_limit(gas_lel: float, gas_trend: float, limit: float) -> float | None:
    """Minutes until `gas_lel` reaches `limit` at the observed trend.

    None when the gas is flat, falling, or already at/over the limit (in which
    case the hard interlock has already fired and projection is moot).
    """
    if gas_trend <= 0 or gas_lel >= limit:
        return None
    return (limit - gas_lel) / gas_trend


@dataclass
class PermitRequest:
    permit_type: str          # "Hot Work" | "Confined Space" | "Cold Work" | "Electrical"
    zone: str
    machine_id: str = ""


@dataclass
class ProximateHazard:
    """A neighbouring zone with elevated gas, within a real distance in metres."""
    zone_id: str
    distance_m: float
    gas_lel: float
    rising: bool = False


@dataclass
class ZoneConditions:
    gas_lel: float                    # combustible gas, % LEL (observed)
    # Oxygen, %. **None means not instrumented in this zone**, which is not the
    # same as "normal" and must not be treated as such. The previous default of
    # 20.9 silently asserted a measurement that was never taken, so every
    # confined-space O2 check passed vacuously and a Confined Space permit was
    # indistinguishable from a Cold Work one.
    o2_pct: float | None = None
    toxic_ppm: float = 0.0            # toxic gas, ppm
    gas_trend: float = 0.0            # % LEL per minute (rising if > 0)
    maintenance_active: bool = False
    workers_in_zone: int = 0
    # PPE compliance gap from the vision layer (heads seen without helmets).
    # Advisory evidence: it can downgrade a permit, never reject or clear one.
    uncovered_heads: int = 0
    ppe_verified: bool = True         # False when the detector could not judge
    # Simultaneous-operations context: neighbouring units venting nearby. Empty
    # by default, so every existing caller and test is unaffected.
    proximate_hazards: list[ProximateHazard] = field(default_factory=list)


@dataclass
class PermitDecision:
    status: str                       # "APPROVED" | "REJECTED" | "CONDITIONAL"
    reasons: list[str] = field(default_factory=list)
    citations: list[str] = field(default_factory=list)
    # Every test performed, with the numbers it was performed on, whatever the
    # outcome. `reasons` explains why the verdict is not APPROVED; `checks` is
    # the audit trail showing the work -- so a clean permit is evidence that the
    # interlocks ran, not a bare "all readings within limits".
    checks: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"status": self.status, "reasons": self.reasons,
                "citations": self.citations, "checks": self.checks}


def evaluate_permit(
    req: PermitRequest,
    cond: ZoneConditions,
    compound_risk: float | None = None,
    lead_time_min: int | None = None,
) -> PermitDecision:
    """Return an APPROVE / REJECT / CONDITIONAL decision with citations.

    `compound_risk` (0-1) is the AI forecaster's predicted probability of an
    incident within the forecast horizon. It can only ever make the decision
    *stricter* -- the AI may escalate or veto, but it can never approve work that
    the deterministic gas/oxygen interlocks have rejected. Fail-safe by design.
    """
    reasons: list[str] = []
    citations: list[str] = []
    checks: list[str] = []
    status = "APPROVED"

    ptype = req.permit_type.strip().lower()

    # The gas limit this permit type is actually judged against, so the level
    # check, the trend projection and the audit trail all reference one number.
    if ptype == "hot work":
        limit, limit_label = HOT_WORK_MAX_LEL, "hot-work"
        limit_cite = "OISD-STD-105 §Hot Work / gas testing (%LEL)"
    elif ptype == "confined space":
        limit, limit_label = CONFINED_SPACE_MAX_LEL, "confined-space"
        limit_cite = "OISD-STD-105 §Confined Space Entry"
    else:
        limit, limit_label = GENERAL_MAX_LEL, "general work"
        limit_cite = "OISD-STD-105 §Work Permit / gas testing"

    # ---- hard interlocks by permit type ------------------------------------
    trend_txt = (f"{cond.gas_trend:+.2f} %LEL/min"
                 if cond.gas_trend else "flat")
    checks.append(
        f"Combustible gas: {cond.gas_lel:.2f}% LEL against the {limit_label} "
        f"limit of {limit:.1f}% LEL, trend {trend_txt}."
    )
    if cond.gas_lel >= limit:
        status = _tighten(status, "REJECTED")
        reasons.append(
            f"Combustible gas {cond.gas_lel:.1f}% LEL >= {limit_label} limit "
            f"{limit:.1f}% LEL."
            + (" Ignition source not permitted." if ptype == "hot work" else "")
        )
        citations.append(limit_cite)

    # ---- trend projection: is it safe for the *duration* of the permit? -----
    #
    # The defect this closes: gas below the limit but climbing was approved
    # outright, because nothing looked at the slope unless maintenance happened
    # to be flagged as well.
    eta = minutes_to_limit(cond.gas_lel, cond.gas_trend, limit)
    if eta is not None and eta <= TREND_WATCH_MIN:
        if eta <= TREND_IMMINENT_MIN:
            status = _tighten(status, "REJECTED")
            reasons.append(
                f"Gas {cond.gas_lel:.2f}% LEL is rising at {cond.gas_trend:+.2f} "
                f"%LEL/min and is projected to reach the {limit_label} limit of "
                f"{limit:.1f}% LEL in ~{eta:.0f} min. A permit cannot be issued "
                f"for a window shorter than the work it authorises."
            )
        else:
            status = _tighten(status, "CONDITIONAL")
            reasons.append(
                f"Gas {cond.gas_lel:.2f}% LEL is rising at {cond.gas_trend:+.2f} "
                f"%LEL/min, projected to reach {limit:.1f}% LEL in ~{eta:.0f} min. "
                f"Re-test at 5-minute intervals; the permit is void on the first "
                f"reading at or above {limit:.1f}% LEL."
            )
        citations.append("OISD-STD-105 §Gas testing / re-testing frequency")
        checks.append(f"Trend projection: limit reached in ~{eta:.0f} min at the current slope.")
    elif eta is not None:
        checks.append(f"Trend projection: limit not reached for ~{eta:.0f} min at the current slope.")

    # ---- oxygen, for confined-space entry -----------------------------------
    if ptype == "confined space":
        if cond.o2_pct is None:
            # Not instrumented is not the same as normal. Entry stays possible,
            # but only behind a manual test -- which is what the standard
            # requires anyway.
            status = _tighten(status, "CONDITIONAL")
            reasons.append(
                "Atmospheric oxygen is not instrumented in this zone, so the "
                f"{O2_MIN_PCT}-{O2_MAX_PCT}% entry range cannot be confirmed "
                "remotely. A manual O2 test at the point of entry, recorded on "
                "the permit, is a precondition of entry."
            )
            citations.append("OISD-STD-105 §Confined Space Entry / O2 testing")
            checks.append("Oxygen: NOT MEASURED -- no O2 instrument bound to this zone.")
        else:
            checks.append(
                f"Oxygen: {cond.o2_pct:.1f}% against the entry range "
                f"{O2_MIN_PCT}-{O2_MAX_PCT}%."
            )
            if not (O2_MIN_PCT <= cond.o2_pct <= O2_MAX_PCT):
                status = _tighten(status, "REJECTED")
                reasons.append(
                    f"Oxygen {cond.o2_pct:.1f}% outside safe range "
                    f"{O2_MIN_PCT}-{O2_MAX_PCT}%."
                )
                citations.append("OISD-STD-105 §Confined Space Entry / O2 testing")

    # ---- PPE compliance (advisory evidence, downgrade only) -----------------
    #
    # Deliberately NOT part of the risk probability: a missing helmet does not
    # make a release more likely, it makes the outcome worse. Same layer as
    # exposure -- see decision/priority.py. It can therefore downgrade a permit
    # but can never reject one on its own, and never clears anything.
    if not cond.ppe_verified:
        checks.append("PPE: not verifiable from the bound frame -- treat as unconfirmed.")
    elif cond.uncovered_heads > 0:
        status = _tighten(status, "CONDITIONAL")
        reasons.append(
            f"Vision layer counts {cond.uncovered_heads} head(s) without a helmet "
            f"in this zone. Head protection must be confirmed on site before work "
            f"starts; this is advisory detection, not a substitute for the "
            f"supervisor's check."
        )
        citations.append("Factories Act 1948 §Protective equipment (PPE)")
        checks.append(f"PPE: {cond.uncovered_heads} uncovered head(s) detected.")
    else:
        checks.append("PPE: no uncovered heads detected in the bound frame.")

    if cond.workers_in_zone:
        checks.append(f"Exposure: {cond.workers_in_zone} worker(s) currently in the zone.")

    # ---- compound advisory (deterministic combination logic) ---------------
    if ptype == "hot work":
        if (cond.gas_lel >= COMPOUND_WATCH_LEL and cond.gas_trend > 0
                and cond.maintenance_active):
            status = _tighten(status, "CONDITIONAL")
            reasons.append(
                f"Gas {cond.gas_lel:.1f}% LEL is rising ({cond.gas_trend:+.2f} %LEL/min) "
                f"during active maintenance near a hot-work zone -- compound ignition "
                f"risk. Continuous gas monitoring + standby firewatch required; suspend "
                f"if gas reaches {HOT_WORK_MAX_LEL:.1f}% LEL."
            )
            citations.append("OISD-STD-105 §Simultaneous Operations / continuous monitoring")

    # ---- spatial simultaneous-operations check (deterministic) --------------
    #
    # The brief names this case directly: "hot work permits issued in proximity
    # to areas with elevated gas readings". A zone-local interlock cannot see it
    # -- this zone's own gas may be perfectly clean while the unit 300 m away is
    # venting. Still no model involved: real distance, real threshold.
    if ptype == "hot work" and cond.proximate_hazards:
        checks.append(
            f"Simultaneous operations: {len(cond.proximate_hazards)} zone(s) with "
            f"elevated gas within the proximity radius."
        )
        rising = [h for h in cond.proximate_hazards if h.rising]
        if rising:
            nearest = min(rising, key=lambda h: h.distance_m)
            status = _tighten(status, "CONDITIONAL")
            reasons.append(
                f"Simultaneous operations: {nearest.zone_id} is "
                f"{nearest.distance_m:.0f} m away with gas {nearest.gas_lel:.1f}% LEL "
                f"and rising. Ignition source not permitted upwind of a developing "
                f"release; continuous monitoring and a standby firewatch required, "
                f"and the permit is void if the neighbouring zone reaches "
                f"{HOT_WORK_MAX_LEL:.1f}% LEL."
            )
            citations.append("OISD-STD-105 §Simultaneous Operations / adjacent-area gas")

    # ---- AI compound-risk escalation (can only tighten, never loosen) ------
    if compound_risk is not None:
        lead_txt = f" Predicted threshold crossing in ~{lead_time_min} min." if lead_time_min else ""
        checks.append(
            f"Compound-risk model: {compound_risk:.0%} probability of an incident "
            f"within the forecast horizon (escalation at 50%, veto at 85%)."
            + lead_txt
        )
        if compound_risk >= 0.85:
            status = _tighten(status, "REJECTED")
            reasons.append(
                f"AI compound-risk model predicts {compound_risk:.0%} probability of an "
                f"incident within the forecast horizon.{lead_txt} Multi-signal evidence "
                f"(pressure, temperature, vibration, operational context) indicates a "
                f"developing hazard the single gas sensor cannot see."
            )
            citations.append("Sentinel-Gemma Compound Risk Forecaster (SHAP-explained)")
        elif compound_risk >= 0.50:
            status = _tighten(status, "CONDITIONAL")
            reasons.append(
                f"AI compound-risk elevated ({compound_risk:.0%}).{lead_txt} "
                f"Continuous gas monitoring and standby firewatch required."
            )
            citations.append("Sentinel-Gemma Compound Risk Forecaster (SHAP-explained)")

    if not reasons:
        reasons.append(
            f"Every interlock below was evaluated against live readings and none "
            f"tripped. {len(checks)} check(s) passed; the permit is approved for "
            f"the conditions observed at this minute only."
        )
    # De-duplicate citations while preserving the order they were raised in.
    citations = list(dict.fromkeys(citations))
    return PermitDecision(status=status, reasons=reasons,
                          citations=citations, checks=checks)


def evaluate_interlocks(cond: ZoneConditions, hot_work_active: bool) -> list[str]:
    """Standing interlocks that fire regardless of a specific permit request."""
    violations: list[str] = []
    if hot_work_active and cond.gas_lel >= HOT_WORK_MAX_LEL:
        violations.append(
            f"ACTIVE hot-work with gas {cond.gas_lel:.1f}% LEL >= "
            f"{HOT_WORK_MAX_LEL:.1f}% LEL -- SUSPEND immediately (OISD-STD-105)."
        )
    if cond.gas_lel >= GENERAL_MAX_LEL and cond.workers_in_zone > 0:
        violations.append(
            f"{cond.workers_in_zone} worker(s) in zone with gas {cond.gas_lel:.1f}% LEL "
            f">= {GENERAL_MAX_LEL:.1f}% LEL -- evacuation advised."
        )
    return violations
