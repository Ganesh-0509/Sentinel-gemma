"""Single-sensor baseline detector -- the scientific control group.

This is deliberately the classic industrial alarm: one gas sensor, one fixed
threshold. It is what most plants (and most hackathon entries) actually do. Our
whole value proposition is measured *against* this, so it must be a fair, honest
implementation -- not a strawman.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from sentinel import config as C


def baseline_alarm_series(episode: pd.DataFrame) -> np.ndarray:
    """Boolean per-minute alarm: gas point-sensor >= first-alarm threshold."""
    return (episode["gas_sensor"].to_numpy() >= C.GAS_BASELINE_ALARM)


def baseline_alarm_time(episode: pd.DataFrame) -> int | None:
    """Minute of the first single-sensor alarm, or None if it never fires."""
    alarms = baseline_alarm_series(episode)
    idx = np.argmax(alarms) if alarms.any() else None
    if idx is None:
        return None
    return int(episode["minute"].to_numpy()[idx])
