"""Physics-lite scenario simulator for an industrial plant zone.

Design goal (why this is NOT circular ML):
    We do not hand-label "risk = critical". We simulate realistic *dynamics* of a
    zone (gas build-up, pressure/temperature response, operational events). An
    **incident** is a physical condition that emerges from those dynamics:

        explosion  : gas_true >= GAS_IGNITION_INCIDENT AND a hot-work permit is active
        toxic      : gas_true >= GAS_TOXIC_INCIDENT   (dangerous accumulation)

    The forecaster is later trained to PREDICT that future physical event from the
    *observable* signals available now. It therefore has to learn genuine leading
    indicators (trends, pressure/temperature signature, operational context) -- not
    a rule we wrote about the present.

Key realism knob -- true hazard vs single point sensor:
    `gas_true`   drives the physics (and the incident condition, and pressure/temp).
    `gas_sensor` is what ONE fixed point sensor reads -- an attenuated, noisy view of
                 `gas_true`. Poor sensor placement / disturbed airflow (common during
                 maintenance) lowers the attenuation factor, so the point sensor can
                 stay quiet while the zone is genuinely dangerous. This mirrors the
                 Vizag pattern: "the signal existed but was not connected."
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from sentinel import config as C

# Scenario mix used to build a dataset. Weights are sampling probabilities.
SCENARIO_MIX = {
    "normal": 0.30,             # no leak (may contain harmless sensor spikes)
    "gas_leak_visible": 0.18,   # leak, well-placed sensor, no hot work -> toxic, baseline sees it
    "compound_hidden": 0.37,    # leak + maintenance + hot work + attenuated sensor -> explosion, baseline struggles
    "maintenance_no_leak": 0.15,  # busy zone, no leak -> tests false alarms
}

# --- operator response model (this is what makes shift state causal) --------
# Without a human-response mechanism, a leak grows unchecked regardless of who is
# on duty, so shift features CANNOT matter. Modelling detection latency gives
# shift state a real causal path: shift -> detection speed -> isolated in time?
NOTICE_LEL = 6.0            # control-room reacts once the point sensor reads this
P_DETECT_BASE = 0.10        # per-minute chance a day-shift crew spots and acts
NIGHT_FACTOR = 0.45         # fatigue, thinner staffing, slower escalation
CHANGEOVER_FACTOR = 0.20    # attention split during handover
HANDOVER_LOSS_PROB = 0.50   # chance the outgoing crew fails to pass the concern on
HANDOVER_LOSS_FACTOR = 0.30  # detection penalty for the lost-information period
HANDOVER_LOSS_MINUTES = 30
CHANGEOVER_PRE = 10          # window before the changeover minute
CHANGEOVER_POST = 15         # window after
VENT_DECAY = 0.90           # gas decay per minute once the leak is isolated


def _ar1(n, mean, sd, phi, rng):
    """Simple AR(1) noise series around `mean`."""
    x = np.empty(n)
    x[0] = mean + rng.normal(0, sd)
    for t in range(1, n):
        x[t] = mean + phi * (x[t - 1] - mean) + rng.normal(0, sd)
    return x


def simulate_episode(scenario: str, rng: np.random.Generator, episode_id: int = 0) -> pd.DataFrame:
    """Simulate one 4-hour episode at 1-minute resolution.

    Returns a DataFrame with observable signals + operational context, plus the
    hidden `gas_true` and the derived `incident` / `incident_onset` columns.
    """
    n = C.EPISODE_MINUTES
    t = np.arange(n)

    # ---- operational context schedule ---------------------------------------
    night_shift = int(rng.random() < 0.5)
    maintenance_active = np.zeros(n, dtype=int)
    hot_work = np.zeros(n, dtype=int)
    confined_space = np.zeros(n, dtype=int)

    maint_start = permit_start = None
    if scenario in ("compound_hidden", "maintenance_no_leak"):
        maint_start = int(rng.integers(20, 90))
        maint_len = int(rng.integers(60, 150))
        maintenance_active[maint_start:maint_start + maint_len] = 1
        # a hot-work permit is issued during the maintenance window
        permit_start = maint_start + int(rng.integers(5, 30))
        permit_len = int(rng.integers(45, 120))
        hot_work[permit_start:permit_start + permit_len] = 1
        confined_space[permit_start:permit_start + permit_len] = int(rng.random() < 0.4)
    elif scenario == "gas_leak_visible":
        if rng.random() < 0.3:  # occasional unrelated permit, no hot work near leak
            ps = int(rng.integers(10, 100))
            confined_space[ps:ps + 60] = 1

    # ---- shift changeover schedule -----------------------------------------
    # A 4-hour episode contains at most one crew changeover.
    in_changeover = np.zeros(n, dtype=int)
    t_change = -1
    if rng.random() < 0.55:
        t_change = int(rng.integers(60, 180))
        lo = max(0, t_change - CHANGEOVER_PRE)
        hi = min(n, t_change + CHANGEOVER_POST)
        in_changeover[lo:hi] = 1
    mins_since_changeover = np.full(n, 999.0)
    if t_change >= 0:
        for k in range(t_change, n):
            mins_since_changeover[k] = k - t_change

    # ---- sensor placement / attenuation (decided up-front: the operator only
    #      sees the point sensor, so it also gates human detection) -----------
    if scenario == "compound_hidden":
        attenuation = rng.uniform(0.40, 0.60)   # poor placement / disturbed airflow
    else:
        attenuation = rng.uniform(0.80, 0.96)

    # ---- true gas hazard dynamics + operator response ----------------------
    gas_true = _ar1(n, C.GAS_NORMAL_MEAN, 0.6, 0.6, rng).clip(min=0)
    leak_active = np.zeros(n, dtype=int)
    intervened_at = -1
    handover_lost = t_change >= 0 and rng.random() < HANDOVER_LOSS_PROB

    leak = scenario in ("gas_leak_visible", "compound_hidden")
    if leak:
        leak_start = int(rng.integers(40, 160))
        base_rate = rng.uniform(0.35, 0.9)        # % LEL per minute
        accel = rng.uniform(0.004, 0.012)         # escalation
        for k in range(leak_start, n):
            dt = k - leak_start
            if intervened_at < 0:
                leak_active[k] = 1
                # maintenance disturbs seals -> faster release (compound driver)
                amp = 1.0 + 0.9 * maintenance_active[k]
                rate = (base_rate + accel * dt) * amp
                gas_true[k] = gas_true[k - 1] + rate + rng.normal(0, 0.4)

                # --- can a human catch it in time? ---
                observed = attenuation * gas_true[k]
                if observed >= NOTICE_LEL:
                    p = P_DETECT_BASE
                    if night_shift:
                        p *= NIGHT_FACTOR
                    if in_changeover[k]:
                        p *= CHANGEOVER_FACTOR
                    # concern raised before handover but never passed on
                    if (handover_lost and leak_start < t_change <= k
                            and k - t_change < HANDOVER_LOSS_MINUTES):
                        p *= HANDOVER_LOSS_FACTOR
                    if rng.random() < p:
                        intervened_at = k
            else:
                # leak isolated -> ventilation brings the zone back down
                gas_true[k] = max(
                    C.GAS_NORMAL_MEAN, gas_true[k - 1] * VENT_DECAY
                ) + rng.normal(0, 0.25)
        gas_true = gas_true.clip(min=0)

    # ---- correlated signals driven by the TRUE hazard -----------------------
    excess = np.clip(gas_true - C.GAS_NORMAL_MEAN, 0, None)
    pressure = _ar1(n, 8.0, 0.06, 0.7, rng) + 0.045 * excess          # leak raises pressure
    temperature = _ar1(n, 55.0, 0.5, 0.7, rng) + 0.07 * excess + 1.8 * maintenance_active
    vibration = _ar1(n, 1.0, 0.08, 0.6, rng) + 0.7 * maintenance_active + 0.008 * excess

    # ---- single point sensor: attenuated, noisy view of gas_true ------------
    gas_sensor = (attenuation * gas_true + rng.normal(0, 0.7, n)).clip(min=0)

    # harmless transient sensor spikes (glitches) -> the baseline's false alarms
    n_spikes = rng.poisson(0.6 if scenario != "gas_leak_visible" else 0.2)
    for _ in range(int(n_spikes)):
        s = int(rng.integers(0, n - 2))
        gas_sensor[s:s + 2] += rng.uniform(9, 16)   # briefly trips a 10 %LEL alarm

    # ---- workers in zone ----------------------------------------------------
    base_workers = rng.integers(2, 6)
    workers = base_workers + 3 * maintenance_active + 2 * hot_work
    workers = (workers - (2 if night_shift else 0)).clip(min=0)

    # ---- incident condition (uses the TRUE hazard) --------------------------
    explosion = (gas_true >= C.GAS_IGNITION_INCIDENT) & (hot_work == 1)
    toxic = gas_true >= C.GAS_TOXIC_INCIDENT
    incident_any = explosion | toxic
    onset = int(np.argmax(incident_any)) if incident_any.any() else -1

    df = pd.DataFrame({
        "episode_id": episode_id,
        "scenario": scenario,
        "minute": t,
        "gas_sensor": gas_sensor,
        "gas_true": gas_true,          # hidden ground truth (not a model input)
        "pressure": pressure,
        "temperature": temperature,
        "vibration": vibration,
        "maintenance_active": maintenance_active,
        "hot_work_permit": hot_work,
        "confined_space_permit": confined_space,
        "night_shift": night_shift,
        "in_changeover": in_changeover,
        "mins_since_changeover": mins_since_changeover,
        "workers_in_zone": workers,
        "leak_active": leak_active,
        "intervened_at": intervened_at,     # -1 if the leak was never isolated
        "incident": incident_any.astype(int),
    })
    df["incident_onset"] = onset          # -1 if no incident in this episode
    return df


def generate_dataset(n_episodes: int, seed: int, mix: dict | None = None) -> pd.DataFrame:
    """Generate a stacked DataFrame of many episodes following the scenario mix."""
    mix = mix or SCENARIO_MIX
    rng = np.random.default_rng(seed)
    scenarios = list(mix.keys())
    probs = np.array(list(mix.values()), dtype=float)
    probs = probs / probs.sum()

    frames = []
    for ep in range(n_episodes):
        scen = rng.choice(scenarios, p=probs)
        frames.append(simulate_episode(scen, rng, episode_id=ep))
    return pd.concat(frames, ignore_index=True)
