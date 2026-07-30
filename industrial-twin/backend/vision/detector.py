"""Person detection from plant imagery -- replaces the last fabricated input.

Why this module exists
----------------------
`workers_in_zone` was the only number in the risk pipeline that was invented by
the simulator and consumed as if it were observed. It already drives
`_exposure_factor()` in `decision/priority.py`, and therefore alert priority and
the evacuation interlock. Deriving it from an actual detector on actual imagery
turns the exposure term from a story into a measurement.

Deliberate limits
-----------------
* **Detection is advisory. It can raise an exposure estimate, never lower a
  hazard assessment.** A missed detection must never make a zone look safer, so
  the service takes `max(detected, simulated_floor)` rather than trusting the
  camera outright. A camera that sees nothing is not evidence that nobody is
  there -- it is equally consistent with a blocked lens.
* **Nothing safety-critical imports this module.** If torch is missing, the
  policy blocks a DLL, or the model file is absent, `VISION_AVAILABLE` is False
  and every caller falls back. Interlocks are untouched either way.

Model
-----
COCO-pretrained YOLO. Person is COCO class 0, so counting people needs no
training at all -- only PPE classification would, and that is gated on dataset
labels we do not currently hold (see docs/17-vision.md).

matplotlib note
---------------
Ultralytics imports matplotlib for plotting. On this machine an Application
Control policy blocks matplotlib's native `ft2font` DLL, which would otherwise
make the whole package unimportable. Plotting is irrelevant to inference, so a
minimal stub is installed *around the import only* and removed immediately
afterwards -- see `_matplotlib_stub`. It is applied only when the real module
genuinely cannot load, so a healthy environment is never patched, and it never
leaks into the process where SHAP would trip over it.
"""
from __future__ import annotations

import sys
import types
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WEIGHTS = "yolo11n.pt"
PERSON_CLASS_ID = 0

# Fine-tuned PPE model, produced by scripts/train_ppe.py. Optional: when absent
# the detector falls back to COCO person-only counting, which is all the
# occupancy pipeline strictly needs.
PPE_WEIGHTS = ROOT / "models" / "vision" / "ppe" / "weights" / "best.pt"
PPE_CLASSES = ["person", "helmet", "safety-vest", "gloves", "head"]

# A head detected without a helmet is the actual violation signal -- SH17 labels
# heads and helmets separately, so "heads > helmets" is the compliance gap.
PPE_REQUIRED = {"helmet", "safety-vest"}


def ppe_model_available() -> bool:
    return PPE_WEIGHTS.exists()

# Below this confidence a detection is not counted toward occupancy. Chosen to
# be permissive: under-counting people in a hazardous zone is the dangerous
# direction, so we would rather include a marginal detection than drop it.
MIN_CONFIDENCE = 0.25


@contextmanager
def _matplotlib_stub():
    """Temporarily satisfy ultralytics' matplotlib import, then clean up.

    The stub MUST NOT outlive this block. SHAP imports `matplotlib.figure`, and
    it already handles matplotlib being genuinely absent -- but a fake top-level
    `matplotlib` that is not a package makes that import fail in a way SHAP does
    not expect, which breaks the explainer and takes the whole PlantService
    startup down with it. That regression is exactly what this scoping prevents.

    Yields True if a stub was installed, False if the real module was fine.
    """
    try:
        import matplotlib  # noqa: F401
        yield False
        return
    except Exception:
        pass

    names = [
        "matplotlib", "matplotlib.pyplot", "matplotlib.patches",
        "matplotlib.font_manager", "matplotlib.colors", "matplotlib.cm",
    ]
    added = []
    for name in names:
        if name not in sys.modules:
            mod = types.ModuleType(name)
            mod.__version__ = "0.0.0-stub"
            sys.modules[name] = mod
            added.append(name)
    mpl = sys.modules["matplotlib"]
    mpl.pyplot = sys.modules["matplotlib.pyplot"]
    mpl.use = lambda *a, **k: None
    mpl.rcParams = {}
    mpl.get_backend = lambda: "agg-stub"

    # Surface actually touched by ultralytics during dataset checks and
    # training. Each entry here is one that raised AttributeError in practice --
    # this is not speculative padding.
    fm = sys.modules["matplotlib.font_manager"]
    fm.findSystemFonts = lambda *a, **k: []
    fm.FontProperties = type("FontProperties", (), {"__init__": lambda self, *a, **k: None})

    plt = sys.modules["matplotlib.pyplot"]
    for fn in ("figure", "subplots", "plot", "savefig", "close", "imshow",
               "title", "xlabel", "ylabel", "legend", "tight_layout"):
        setattr(plt, fn, lambda *a, **k: None)

    colors = sys.modules["matplotlib.colors"]
    colors.LinearSegmentedColormap = type(
        "LinearSegmentedColormap", (), {"from_list": staticmethod(lambda *a, **k: None)})
    colors.Normalize = type("Normalize", (), {"__init__": lambda self, *a, **k: None})

    try:
        yield True
    finally:
        for name in added:
            sys.modules.pop(name, None)


with _matplotlib_stub() as _stubbed:
    MATPLOTLIB_STUBBED = _stubbed
    try:
        from ultralytics import YOLO
        VISION_AVAILABLE = True
        _IMPORT_ERROR: str | None = None
    except Exception as e:                # torch absent, DLL blocked, etc.
        YOLO = None                       # type: ignore[assignment]
        VISION_AVAILABLE = False
        _IMPORT_ERROR = f"{type(e).__name__}: {e}"


@dataclass
class Detection:
    """One detected object."""
    label: str
    confidence: float
    # Pixel box, (x1, y1, x2, y2).
    bbox: tuple[float, float, float, float]

    def as_dict(self) -> dict:
        x1, y1, x2, y2 = self.bbox
        return {
            "label": self.label,
            "confidence": round(float(self.confidence), 4),
            "bbox": [round(float(v), 1) for v in (x1, y1, x2, y2)],
        }


@dataclass
class FrameAnalysis:
    """Result of analysing one frame."""
    source: str
    person_count: int
    detections: list[Detection] = field(default_factory=list)
    width: int = 0
    height: int = 0
    inference_ms: float = 0.0

    def as_dict(self) -> dict:
        return {
            "source": self.source,
            "person_count": self.person_count,
            "width": self.width,
            "height": self.height,
            "inference_ms": round(self.inference_ms, 1),
            "detections": [d.as_dict() for d in self.detections],
        }


class PersonDetector:
    """Counts people in a frame using a COCO-pretrained YOLO model.

    Constructed lazily: the weights load on first use, so importing this module
    costs nothing if no frame is ever analysed.
    """

    def __init__(self, weights: str = DEFAULT_WEIGHTS,
                 min_confidence: float = MIN_CONFIDENCE):
        if not VISION_AVAILABLE:
            raise RuntimeError(f"vision stack unavailable: {_IMPORT_ERROR}")
        self.weights = weights
        self.min_confidence = min_confidence
        self._model = None

    @property
    def model(self):
        if self._model is None:
            self._model = YOLO(self.weights)
        return self._model

    def analyse(self, image_path: str | Path) -> FrameAnalysis:
        """Detect people in one image."""
        import time

        path = Path(image_path)
        t0 = time.perf_counter()
        res = self.model.predict(str(path), verbose=False,
                                 conf=self.min_confidence)[0]
        elapsed = (time.perf_counter() - t0) * 1000

        names = self.model.names
        dets: list[Detection] = []
        for box in res.boxes:
            cls = int(box.cls.item())
            if cls != PERSON_CLASS_ID:
                continue
            dets.append(Detection(
                label=names.get(cls, str(cls)),
                confidence=float(box.conf.item()),
                bbox=tuple(float(v) for v in box.xyxy[0].tolist()),
            ))

        h, w = (res.orig_shape if getattr(res, "orig_shape", None) else (0, 0))
        return FrameAnalysis(
            source=path.name,
            person_count=len(dets),
            detections=dets,
            width=int(w),
            height=int(h),
            inference_ms=elapsed,
        )


class PPEDetector:
    """PPE compliance from the fine-tuned SH17 model.

    Reports what the frame shows, and the one derived signal that matters
    operationally: **heads without helmets**. SH17 labels `head` and `helmet`
    separately, so an uncovered head is `heads - helmets` rather than something
    the model has to be taught as its own class.

    As with occupancy, this is advisory. A missed helmet detection produces a
    *stricter* reading (an apparent violation), never a permissive one, so the
    failure direction is safe by construction.
    """

    def __init__(self, weights: Path | str = PPE_WEIGHTS,
                 min_confidence: float = MIN_CONFIDENCE):
        if not VISION_AVAILABLE:
            raise RuntimeError(f"vision stack unavailable: {_IMPORT_ERROR}")
        weights = Path(weights)
        if not weights.exists():
            raise FileNotFoundError(
                f"no PPE weights at {weights}; run scripts/train_ppe.py")
        self.weights = weights
        self.min_confidence = min_confidence
        self._model = None

    @property
    def model(self):
        if self._model is None:
            self._model = YOLO(str(self.weights))
        return self._model

    def analyse(self, image_path: str | Path) -> dict:
        import time
        from collections import Counter

        path = Path(image_path)
        t0 = time.perf_counter()
        res = self.model.predict(str(path), verbose=False,
                                 conf=self.min_confidence)[0]
        elapsed = (time.perf_counter() - t0) * 1000

        names = self.model.names
        counts: Counter[str] = Counter()
        dets: list[Detection] = []
        for box in res.boxes:
            label = names.get(int(box.cls.item()), str(int(box.cls.item())))
            counts[label] += 1
            dets.append(Detection(
                label=label,
                confidence=float(box.conf.item()),
                bbox=tuple(float(v) for v in box.xyxy[0].tolist()),
            ))

        heads = counts.get("head", 0)
        helmets = counts.get("helmet", 0)
        uncovered = max(0, heads - helmets)
        return {
            "source": path.name,
            "counts": dict(counts),
            "person_count": counts.get("person", 0),
            "heads": heads,
            "helmets": helmets,
            "uncovered_heads": uncovered,
            "vests": counts.get("safety-vest", 0),
            "ppe_violation": uncovered > 0,
            "inference_ms": round(elapsed, 1),
            "detections": [d.as_dict() for d in dets],
        }


def vision_status() -> dict:
    """Health payload -- reports honestly when the stack is unusable."""
    return {
        "available": VISION_AVAILABLE,
        "weights": DEFAULT_WEIGHTS if VISION_AVAILABLE else None,
        "min_confidence": MIN_CONFIDENCE,
        "matplotlib_stubbed": MATPLOTLIB_STUBBED,
        "error": _IMPORT_ERROR,
        "ppe_model": str(PPE_WEIGHTS) if ppe_model_available() else None,
        "ppe_classes": PPE_CLASSES if ppe_model_available() else [],
    }
