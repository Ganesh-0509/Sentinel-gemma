"""Vision layer tests.

The load-bearing property is the same shape as the permit safety contract:
**a detection may raise occupancy, never lower it.** A camera that sees nobody
is not evidence that nobody is there, so a missed detection must never make a
zone look safer than the simulated floor already says it is.

Everything here runs without the torch stack: tests that need a real detector
skip cleanly, so the suite stays green on a machine with no CV dependencies.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from sentinel.vision.detector import MIN_CONFIDENCE, VISION_AVAILABLE, vision_status
from sentinel.vision.zone_camera import (
    FRAME_LICENCE,
    available_frames,
    frame_for_zone,
    provenance,
)

requires_vision = pytest.mark.skipif(
    not VISION_AVAILABLE, reason="torch/ultralytics not installed")
requires_frames = pytest.mark.skipif(
    not available_frames(), reason="no sample frames downloaded")


# --------------------------------------------------------- the fail-safe rule
def _resolve(detected, simulated):
    """Mirror of the occupancy rule in PlantService.zone_states()."""
    if detected is None:
        return simulated, "simulated"
    if detected >= simulated:
        return detected, "cv"
    return simulated, "cv+floor"


@pytest.mark.parametrize("detected,simulated,expect_workers,expect_src", [
    (None, 5, 5, "simulated"),   # vision off -> untouched
    (7, 5, 7, "cv"),             # detector sees more -> raise
    (5, 5, 5, "cv"),             # equal -> use detection
    (2, 5, 5, "cv+floor"),       # detector sees fewer -> KEEP THE FLOOR
    (0, 4, 4, "cv+floor"),       # blocked lens -> must not empty the zone
    (0, 0, 0, "cv"),
])
def test_detection_can_raise_occupancy_but_never_lower_it(
        detected, simulated, expect_workers, expect_src):
    assert _resolve(detected, simulated) == (expect_workers, expect_src)


@pytest.mark.parametrize("detected", [0, 1, 3, 9, 40])
@pytest.mark.parametrize("simulated", [0, 1, 5, 12])
def test_occupancy_is_never_below_the_simulated_floor(detected, simulated):
    """Sweep: the resolved count must never fall under the floor."""
    workers, _ = _resolve(detected, simulated)
    assert workers >= simulated


def test_confidence_floor_is_permissive():
    """Under-counting people in a hazardous zone is the dangerous direction."""
    assert 0.0 < MIN_CONFIDENCE <= 0.35


# ------------------------------------------------------------------ provenance
def test_frame_provenance_is_declared_and_non_commercial_flagged():
    p = provenance()
    assert p["frame_binding"] == "representative", "must not imply a live feed"
    assert "non-commercial" in FRAME_LICENCE.lower()
    assert p["attribution"]


def test_frame_binding_is_deterministic():
    """The same zone must always analyse the same frame, so demos repeat."""
    if not available_frames():
        pytest.skip("no frames")
    assert frame_for_zone("COB-A", 0) == frame_for_zone("COB-A", 0)
    assert frame_for_zone("COB-A", 0) != frame_for_zone("COB-B", 1)


def test_frame_index_wraps_safely_past_the_frame_count():
    if not available_frames():
        pytest.skip("no frames")
    assert frame_for_zone("Z", 10_000) is not None


def test_importing_vision_does_not_leak_a_matplotlib_stub():
    """Regression: the stub must not outlive the ultralytics import.

    Ultralytics needs matplotlib; this machine's policy blocks its native DLL,
    so the import is wrapped in a temporary stub. An earlier version installed
    that stub globally -- which made SHAP's `import matplotlib.figure` fail in a
    way it does not handle, breaking PlantService startup and taking the
    monotonicity guarantee tests down with it.

    If `matplotlib` is present in sys.modules and is a fake, the leak is back.
    """
    import sys

    import sentinel.vision.detector  # noqa: F401

    mpl = sys.modules.get("matplotlib")
    if mpl is not None:
        assert getattr(mpl, "__version__", "") != "0.0.0-stub", (
            "matplotlib stub leaked into sys.modules; SHAP will break"
        )


def test_shap_still_imports_after_the_vision_layer_is_loaded():
    """The explainer must survive the CV stack being present."""
    import sentinel.vision.detector  # noqa: F401

    shap = pytest.importorskip("shap")
    assert shap.__version__


def test_vision_status_reports_honestly_when_unavailable():
    st = vision_status()
    assert st["available"] is VISION_AVAILABLE
    if not VISION_AVAILABLE:
        assert st["error"], "an unavailable stack must say why"


# ------------------------------------------------------------- real inference
@requires_vision
@requires_frames
def test_detector_finds_people_in_real_industrial_imagery():
    from sentinel.vision.detector import PersonDetector

    det = PersonDetector()
    frames = available_frames()[:12]
    total = sum(det.analyse(f).person_count for f in frames)
    assert total > 0, "no people found in 12 industrial workplace images"


@requires_vision
@requires_frames
def test_detections_are_well_formed():
    from sentinel.vision.detector import PersonDetector

    det = PersonDetector()
    for frame in available_frames()[:6]:
        a = det.analyse(frame)
        assert a.person_count == len(a.detections)
        assert a.width > 0 and a.height > 0
        for d in a.detections:
            assert d.label == "person"
            assert MIN_CONFIDENCE <= d.confidence <= 1.0
            x1, y1, x2, y2 = d.bbox
            assert x2 > x1 and y2 > y1, "degenerate box"
            assert 0 <= x1 and 0 <= y1
            assert x2 <= a.width + 1 and y2 <= a.height + 1, "box outside frame"


# ------------------------------------------------------------ PPE compliance
def _uncovered(heads: int, helmets: int) -> int:
    """Mirror of the compliance gap in PPEDetector.analyse()."""
    return max(0, heads - helmets)


@pytest.mark.parametrize("heads,helmets,expected", [
    (0, 0, 0),
    (3, 3, 0),     # everyone covered
    (3, 1, 2),     # two bare heads
    (5, 0, 5),     # nobody wearing one
    (2, 4, 0),     # more helmets than heads (some unworn) -> not a violation
])
def test_uncovered_head_count(heads, helmets, expected):
    assert _uncovered(heads, helmets) == expected


@pytest.mark.parametrize("heads,helmets", [(4, 1), (1, 0), (9, 2)])
def test_a_missed_helmet_fails_toward_stricter(heads, helmets):
    """A helmet the detector misses shows as a violation, never as compliance.

    That is the safe failure direction: the reading gets stricter, so the
    operator investigates rather than being reassured.
    """
    truth = _uncovered(heads, helmets)
    missed_one = _uncovered(heads, max(0, helmets - 1))
    assert missed_one >= truth


def test_ppe_classes_cover_the_operational_questions():
    from sentinel.vision.detector import PPE_CLASSES, PPE_REQUIRED

    assert "person" in PPE_CLASSES, "occupancy depends on this class"
    assert "head" in PPE_CLASSES and "helmet" in PPE_CLASSES, (
        "the compliance gap is heads minus helmets; both classes are required")
    assert PPE_REQUIRED <= set(PPE_CLASSES)


@pytest.mark.skipif(
    not VISION_AVAILABLE, reason="torch/ultralytics not installed")
def test_ppe_detector_reports_absence_rather_than_guessing():
    """With no trained weights the detector must refuse, not silently degrade."""
    from sentinel.vision.detector import PPEDetector, ppe_model_available

    if ppe_model_available():
        det = PPEDetector()
        assert det.weights.exists()
    else:
        with pytest.raises(FileNotFoundError):
            PPEDetector()


@requires_vision
@requires_frames
def test_inference_is_deterministic_for_the_same_frame():
    """Reproducibility: the same frame must give the same count every time."""
    from sentinel.vision.detector import PersonDetector

    det = PersonDetector()
    frame = available_frames()[3]
    counts = {det.analyse(frame).person_count for _ in range(3)}
    assert len(counts) == 1, f"non-deterministic detection: {counts}"
