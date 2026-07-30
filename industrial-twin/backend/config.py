"""Shared constants for SentinelAI.

Gas is expressed in **% LEL** (percent of Lower Explosive Limit), the same unit
OISD-STD-105 mandates for hot-work / confined-space gas testing. Values here are
scaled for a clear demo but the *relationships* mirror real permit logic:
a first gas alarm typically sits around 10 % LEL and hot work is suspended well
before the gas-air mixture becomes explosive.
"""

# ---------------------------------------------------------------- sampling
SAMPLE_MINUTES = 1            # one reading per minute
EPISODE_MINUTES = 240        # 4-hour episodes

# ------------------------------------------------------- gas thresholds (% LEL)
GAS_NORMAL_MEAN = 2.0         # steady-state background reading
GAS_BASELINE_ALARM = 10.0    # classic single-sensor first alarm (baseline uses this)
GAS_HIGH_ALARM = 20.0        # high alarm
GAS_TOXIC_INCIDENT = 40.0    # dangerous accumulation -> incident regardless of ignition
GAS_IGNITION_INCIDENT = 20.0 # with a hot-work ignition source present -> explosion incident

# --------------------------------------------------------- forecast horizons (min)
HORIZONS = [15, 30, 60]
PRIMARY_HORIZON = 30         # model predicts P(incident within next 30 min)

# --------------------------------------------------------- feature engineering
WINDOW_MINUTES = 10          # look-back window for rolling features
ROC_LAG_MINUTES = 5          # rate-of-change lag

# --------------------------------------------------------- decision thresholds
# Default operating point for the compound model; the eval harness can also pick
# an F1-optimal threshold on a validation split.
MODEL_DECISION_THRESHOLD = 0.50

# --------------------------------------------------------- plant clock
# The API runs its own clock so the console shows a continuously advancing plant
# from the moment the backend starts -- a control room does not stop because an
# operator changed screens. This is wall-clock seconds per plant minute; the
# clock wraps at the end of the episode and replays from minute 0.
# Override at runtime with SENTINEL_CLOCK_SECONDS.
CLOCK_SECONDS_PER_MINUTE = 1.0

# --------------------------------------------------------- reproducibility
GLOBAL_SEED = 20260720
