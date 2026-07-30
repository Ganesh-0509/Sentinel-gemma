"""Computer vision layer: real person counts from real imagery.

Exports are lazy -- importing this package must never pull in torch, because the
safety-critical path (forecaster + rule engine) does not depend on vision and
must keep working when the CV stack is absent.
"""
from sentinel.vision.detector import (
    PPE_CLASSES,
    VISION_AVAILABLE,
    Detection,
    FrameAnalysis,
    PersonDetector,
    PPEDetector,
    ppe_model_available,
    vision_status,
)

__all__ = [
    "PPE_CLASSES",
    "VISION_AVAILABLE",
    "Detection",
    "FrameAnalysis",
    "PPEDetector",
    "PersonDetector",
    "ppe_model_available",
    "vision_status",
]
