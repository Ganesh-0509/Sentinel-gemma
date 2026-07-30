"""Alert prioritisation -- where shift/roster signals actually belong.

The ablation (scripts/ablation_shift.py) showed that feeding shift/roster features
into the RISK MODEL is actively harmful: they let the model infer "a human will
probably catch this" and under-alert by 17.8 points of detection at a matched
false-alarm rate.

But those signals are far from useless -- they were simply in the wrong layer.
Shift state does not change *how likely a hazard is*; it changes *how bad the
consequence is* and *how fast we must act*:

    risk  = P(incident)          <- the model's job, hazard only
    impact = people exposed      <- consequence
    urgency = response capacity  <- night shift / changeover slow response down

Keeping these separate means the model never learns complacency, while the
control room still sees "8 people in this zone, mid-handover" at the top of the
queue. This is also what de-noises the alert feed.
"""
from __future__ import annotations

from dataclasses import dataclass

PRIORITY_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]


@dataclass
class AlertContext:
    risk: float                       # 0-1, from the compound forecaster
    workers_in_zone: int = 0
    night_shift: bool = False
    in_changeover: bool = False
    asset_criticality: float = 1.0    # 1.0 = normal, >1 for critical equipment
    lead_time_min: int | None = None
    # IEC 60079-10-1 hazardous area class of the zone. Consequence, not hazard:
    # an identical probability in a Zone 1 area carries a worse outcome than in
    # an unclassified one, so it lifts queue position without ever touching the
    # model's assessment. Same principle as exposure and urgency.
    area_class: str = "SAFE"
    proximate_hazards: int = 0        # neighbouring zones venting within radius
    # Heads seen without a helmet by the vision layer. Consequence, not hazard:
    # a missing helmet does not make a release more likely, it makes the outcome
    # of one worse -- so it belongs here beside exposure, and never in `risk`.
    # This is why the CCTV panel's PPE badge and the zone's risk percentage are
    # different numbers: they answer different questions.
    uncovered_heads: int = 0


def _exposure_factor(workers: int) -> float:
    """More people in harm's way -> higher consequence (saturating)."""
    if workers <= 0:
        return 0.6            # unoccupied zone: still act, but lower queue position
    if workers <= 2:
        return 1.0
    if workers <= 5:
        return 1.3
    return 1.6


def _urgency_factor(night_shift: bool, in_changeover: bool) -> float:
    """Degraded response capacity means we need to escalate sooner."""
    f = 1.0
    if night_shift:
        f *= 1.20         # thinner staffing, slower escalation
    if in_changeover:
        f *= 1.35         # attention split, handover information loss risk
    return f


def _ppe_factor(uncovered_heads: int) -> float:
    """Unprotected people raise the severity of the same event (saturating).

    Capped well below the exposure and urgency factors on purpose: this comes
    from an advisory detector on a representative frame, so it should nudge
    queue position, never dominate it.
    """
    if uncovered_heads <= 0:
        return 1.0
    return min(1.20, 1.0 + 0.07 * uncovered_heads)


def _area_factor(area_class: str) -> float:
    """Hazardous area classification weighting (IEC 60079-10-1)."""
    from sentinel.geo.site import AREA_CLASS_FACTOR, HazardousAreaClass
    try:
        return AREA_CLASS_FACTOR[HazardousAreaClass(area_class)]
    except ValueError:
        return 1.0


def prioritise(ctx: AlertContext) -> dict:
    """Return a priority label plus the factors that produced it (explainable)."""
    exposure = _exposure_factor(ctx.workers_in_zone)
    urgency = _urgency_factor(ctx.night_shift, ctx.in_changeover)
    area = _area_factor(ctx.area_class)
    ppe = _ppe_factor(ctx.uncovered_heads)
    score = ctx.risk * exposure * urgency * area * ppe * ctx.asset_criticality

    if score >= 1.10:
        level = "CRITICAL"
    elif score >= 0.70:
        level = "HIGH"
    elif score >= 0.35:
        level = "MEDIUM"
    else:
        level = "LOW"

    drivers = []
    if ctx.workers_in_zone > 0:
        drivers.append(f"{ctx.workers_in_zone} worker(s) in zone")
    if ctx.night_shift:
        drivers.append("night shift (slower response)")
    if ctx.in_changeover:
        drivers.append("shift changeover (handover risk)")
    if area > 1.0:
        drivers.append(f"hazardous area {ctx.area_class.replace('_', ' ').title()}")
    if ctx.proximate_hazards:
        drivers.append(f"{ctx.proximate_hazards} adjacent zone(s) venting nearby")
    if ctx.uncovered_heads > 0:
        drivers.append(f"{ctx.uncovered_heads} worker(s) detected without a helmet")
    if ctx.asset_criticality > 1.0:
        drivers.append("critical asset")
    # Only a *positive* lead time is information. `None` means no horizon model
    # fired, and rendering that as "~0 min to threshold" read as "it is
    # happening now" on every low-risk zone in the console.
    if ctx.lead_time_min is not None and ctx.lead_time_min > 0:
        drivers.append(f"~{ctx.lead_time_min} min to threshold")

    return {
        "priority": level,
        "score": round(float(score), 3),
        "risk": round(float(ctx.risk), 3),
        "exposure_factor": exposure,
        "urgency_factor": round(urgency, 2),
        "area_factor": round(area, 2),
        "ppe_factor": round(ppe, 2),
        "drivers": drivers,
    }
