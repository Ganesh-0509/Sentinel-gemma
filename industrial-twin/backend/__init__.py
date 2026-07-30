"""SentinelAI - AI-Powered Industrial Safety Intelligence Platform.

Package layout:
    sentinel.config          - shared constants (thresholds, horizons, units)
    sentinel.sim.simulator   - physics-lite scenario simulator (emergent labels)
    sentinel.ml.features      - feature engineering (the 'compound' intelligence)
    sentinel.ml.baseline      - single-sensor baseline detector (the control group)
    sentinel.ml.forecaster    - compound risk forecaster (LightGBM, multi-horizon)
    sentinel.evaluation.harness - baseline-vs-compound scoreboard
"""

__version__ = "0.1.0"
