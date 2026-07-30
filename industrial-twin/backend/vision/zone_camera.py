"""Binds zone occupancy to real detections on real frames.

What is real here, and what is not
----------------------------------
**Real:** the imagery (SH17, industrial workplaces), the detector (COCO-pretrained
YOLO), the inference, and the resulting person counts.

**Representative:** which frame is assigned to which plant zone. There is no
camera at Visakhapatnam feeding this system. Frames are bound to zones
deterministically so the demo is reproducible, and the API reports
`frame_binding: "representative"` rather than implying a live feed.

Same discipline as the geospatial layer: the externally-sourced part is real and
attributable, the modelled part says so.

The fail-safe rule
------------------
A detected count may only ever *raise* the occupancy used for decisions:

    workers_used = max(detected, simulated_floor)

A camera that sees nobody is not evidence that nobody is there -- it is equally
consistent with a blocked lens, a bad angle, or a worker behind a vessel.
Letting a missed detection lower exposure would make a zone look safer than it
is, which is the one direction a safety system must never fail in. This mirrors
the model-can-only-tighten rule in the permit engine.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRAME_DIR = ROOT / "data" / "external" / "sh17_sample"

# Provenance for the imagery, surfaced through the API.
FRAME_SOURCE = "SH17 dataset (industrial workplace imagery)"
FRAME_LICENCE = "CC BY-NC-SA 4.0 -- non-commercial"
FRAME_ATTRIBUTION = (
    "SH17: Ahmad et al., A Dataset for Human Safety and PPE Detection in "
    "Manufacturing Industry (arXiv:2407.04590). Images via Pexels."
)


def vision_enabled() -> bool:
    """CV occupancy is opt-in: it adds startup cost and needs the torch stack."""
    return os.environ.get("SENTINEL_VISION", "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class ZoneOccupancy:
    zone_id: str
    frame: str
    detected: int
    confidences: list[float]
    inference_ms: float
    # PPE fields are populated only when the fine-tuned model is present.
    heads: int | None = None
    helmets: int | None = None
    uncovered_heads: int | None = None
    vests: int | None = None
    ppe_violation: bool = False
    # False when the PPE verdict cannot be trusted for this run -- see
    # `_mark_ppe_confidence`. The count is still reported; what changes is that
    # the console labels it unverified instead of asserting a violation.
    ppe_verified: bool = True

    def as_dict(self) -> dict:
        return {
            "zone_id": self.zone_id,
            "frame": self.frame,
            "detected": self.detected,
            "confidences": [round(c, 3) for c in self.confidences],
            "inference_ms": round(self.inference_ms, 1),
            "heads": self.heads,
            "helmets": self.helmets,
            "uncovered_heads": self.uncovered_heads,
            "vests": self.vests,
            "ppe_violation": self.ppe_violation,
            "ppe_verified": self.ppe_verified,
        }


def available_frames() -> list[Path]:
    if not FRAME_DIR.exists():
        return []
    return sorted(FRAME_DIR.glob("*.jpg"))


def frame_for_zone(zone_id: str, index: int) -> Path | None:
    """Deterministic frame binding, so the same zone always shows the same frame."""
    frames = available_frames()
    if not frames:
        return None
    return frames[index % len(frames)]


def _mark_ppe_confidence(occ: dict[str, ZoneOccupancy]) -> None:
    """Detect a degenerate PPE head and label its verdicts unverified.

    `uncovered_heads = heads - helmets` is only a compliance signal if the
    helmet class actually fires. When the fine-tuned model detects heads across
    the whole site but *never once* detects a helmet, the far likelier
    explanation is an under-trained helmet class than eight simultaneous
    bare-headed crews -- and the console ends up painting a red PPE badge on
    every zone, which is indistinguishable from noise.

    The count is left untouched (suppressing it would hide a real violation).
    Only the *verdict* is downgraded to unverified, so an operator sees "PPE
    unverified -- helmet class not firing" rather than a confident red flag they
    learn to ignore. Fail-safe is preserved: the zone is still surfaced.
    """
    ppe_zones = [o for o in occ.values() if o.heads is not None]
    if not ppe_zones:
        return
    heads = sum(o.heads or 0 for o in ppe_zones)
    helmets = sum(o.helmets or 0 for o in ppe_zones)
    if heads > 0 and helmets == 0:
        for o in ppe_zones:
            o.ppe_verified = False


def analyse_zones(zone_ids: list[str]) -> dict[str, ZoneOccupancy]:
    """Run the detector once per zone. Returns {} if vision is unavailable.

    Failure is always silent-and-degrade, never fatal: occupancy simply falls
    back to the simulated value and the rest of the system is unaffected.
    """
    from sentinel.vision.detector import (
        VISION_AVAILABLE,
        PersonDetector,
        PPEDetector,
        ppe_model_available,
    )

    if not VISION_AVAILABLE or not available_frames():
        return {}

    try:
        detector = PersonDetector()
    except Exception:
        return {}

    # Prefer the fine-tuned PPE model when it exists: it counts people *and*
    # reports compliance in one pass. Fall back to person-only if absent or
    # broken -- occupancy is the part the risk pipeline actually depends on.
    ppe = None
    if ppe_model_available():
        try:
            ppe = PPEDetector()
        except Exception:
            ppe = None

    out: dict[str, ZoneOccupancy] = {}
    for i, zid in enumerate(zone_ids):
        frame = frame_for_zone(zid, i)
        if frame is None:
            continue

        if ppe is not None:
            try:
                r = ppe.analyse(frame)
                out[zid] = ZoneOccupancy(
                    zone_id=zid, frame=frame.name,
                    detected=r["person_count"],
                    confidences=[d["confidence"] for d in r["detections"]
                                 if d["label"] == "person"],
                    inference_ms=r["inference_ms"],
                    heads=r["heads"], helmets=r["helmets"],
                    uncovered_heads=r["uncovered_heads"], vests=r["vests"],
                    ppe_violation=r["ppe_violation"],
                )
                continue
            except Exception:
                pass  # fall through to person-only

        try:
            a = detector.analyse(frame)
        except Exception:
            continue
        out[zid] = ZoneOccupancy(
            zone_id=zid,
            frame=frame.name,
            detected=a.person_count,
            confidences=[d.confidence for d in a.detections],
            inference_ms=a.inference_ms,
        )
    _mark_ppe_confidence(out)
    return out


def provenance() -> dict:
    return {
        "frame_source": FRAME_SOURCE,
        "frame_licence": FRAME_LICENCE,
        "attribution": FRAME_ATTRIBUTION,
        "frame_binding": "representative",
        "frames_available": len(available_frames()),
    }
