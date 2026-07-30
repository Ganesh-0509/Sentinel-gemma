"""Live plant state service.

Holds one running episode per zone, precomputes the model outputs once at startup,
then serves a moving "now" pointer. Swapping the simulator for a live SCADA feed
means replacing `_load_zones` only -- everything downstream is unchanged.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from sentinel import config as C
from sentinel.decision.priority import AlertContext, prioritise
from sentinel.geo.site import (
    PROXIMITY_RADIUS_M,
    HazardousAreaClass,
    haversine_m,
    point_inside_site,
)
from sentinel.ml.anomaly import AnomalyDetector
from sentinel.ml.baseline import baseline_alarm_series
from sentinel.ml.explain import RiskExplainer
from sentinel.ml.features import build_features
from sentinel.ml.forecaster import CompoundRiskForecaster
from sentinel.sim.simulator import generate_dataset, simulate_episode

ROOT = Path(__file__).resolve().parents[2]
MODEL_PATH = ROOT / "models" / "forecaster.pkl"

# Plant layout.
#
#   x, y        floor-plan coordinates on a 0-100 grid, used for 2D rendering.
#   lat, lon    WGS84, inside the real RINL site boundary (OSM way 395219953).
#               Representative unit placement -- see sentinel/geo/site.py for the
#               provenance of what is real here and what is modelled.
#   area_class  IEC 60079-10-1 hazardous area classification, reasoned per unit:
#                 GAS-H  gas holder yard    -> ZONE_0, flammable gas by design
#                 COB-A/B coke oven batteries, BYP-1 by-product plant,
#                 BLF-2 blast furnace (CO), TNK-3 tank farm
#                                            -> ZONE_1, release likely in normal ops
#                 SIN-1 sinter, PWR-1 power  -> ZONE_2, release unlikely/short
ZONE_LAYOUT = [
    ("COB-A", "Coke Oven Battery A", 18, 24, "gas_leak_visible",
     17.63527, 83.17365, HazardousAreaClass.ZONE_1),
    ("COB-B", "Coke Oven Battery B", 38, 24, "compound_hidden",
     17.64130, 83.18510, HazardousAreaClass.ZONE_1),
    ("BYP-1", "By-Product Plant", 62, 20, "normal",
     17.63235, 83.19391, HazardousAreaClass.ZONE_1),
    ("GAS-H", "Gas Holder Yard", 84, 30, "normal",
     17.62760, 83.20277, HazardousAreaClass.ZONE_0),
    ("SIN-1", "Sinter Plant", 20, 58, "maintenance_no_leak",
     17.61192, 83.17192, HazardousAreaClass.ZONE_2),
    ("BLF-2", "Blast Furnace 2", 46, 62, "compound_hidden",
     17.60846, 83.19095, HazardousAreaClass.ZONE_1),
    ("PWR-1", "Power & Blowing Stn", 72, 60, "normal",
     17.61054, 83.20865, HazardousAreaClass.ZONE_2),
    ("TNK-3", "Tank Farm 3", 30, 86, "gas_leak_visible",
     17.58772, 83.17924, HazardousAreaClass.ZONE_1),
]

RISK_BANDS = [(0.30, "LOW"), (0.60, "MEDIUM"), (0.85, "HIGH")]

# How many alert-log entries to retain. The log is the console's memory: the
# live queue only ever shows the current minute, so an alert that rose and
# cleared while nobody was looking used to leave no trace at all. 240 minutes x
# 8 zones x a handful of transitions each fits comfortably.
ALERT_LOG_MAX = 1000

_PRIORITY_RANK = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


def _band(risk: float) -> str:
    for edge, name in RISK_BANDS:
        if risk < edge:
            return name
    return "CRITICAL"


@dataclass
class ZoneRuntime:
    zone_id: str
    name: str
    x: float
    y: float
    lat: float
    lon: float
    area_class: HazardousAreaClass
    episode: pd.DataFrame
    features: pd.DataFrame
    proba: np.ndarray
    anomaly: np.ndarray
    baseline: np.ndarray
    # horizon (minutes) -> per-minute probability from that horizon's model
    horizon_proba: dict[int, np.ndarray] = field(default_factory=dict)


class PlantService:
    """Singleton-ish holder for models + live zone state."""

    def __init__(self):
        self._lock = threading.Lock()
        self.minute = 0
        # Clock telemetry, owned by the background ticker in api/app.py.
        self.laps = 0
        self.clock_running = False
        self.seconds_per_minute = C.CLOCK_SECONDS_PER_MINUTE
        self.model: CompoundRiskForecaster | None = None
        self.horizon_models: dict[int, CompoundRiskForecaster] = {}
        self.explainer: RiskExplainer | None = None
        self.detector: AnomalyDetector | None = None
        self.zones: list[ZoneRuntime] = []
        # zone_id -> ZoneOccupancy from the CV layer (empty unless SENTINEL_VISION=1)
        self.occupancy: dict = {}
        self.vision_on = False
        self.store = None
        self.ready = False
        self.error: str | None = None
        # --- alert log -----------------------------------------------------
        # Append-only history of alert transitions, written once per plant
        # minute by the clock. `_open` holds the alert currently standing for
        # each zone, which is what makes CLEARED and ESCALATED detectable
        # rather than just re-reporting the same alert every tick.
        self.alert_log: list[dict] = []
        self._open: dict[str, dict] = {}
        self._log_seq = 0

    # ------------------------------------------------------------------ setup
    def startup(self) -> None:
        try:
            if not MODEL_PATH.exists():
                self.error = ("no trained model at models/forecaster.pkl -- "
                              "run scripts/run_pipeline.py first")
                return
            self.model = CompoundRiskForecaster.load(MODEL_PATH)
            self.explainer = RiskExplainer(self.model)

            # Shorter/longer horizons power the lead-time forecast. Missing
            # files are tolerated: lead time degrades to the primary window.
            for horizon in C.HORIZONS:
                path = (MODEL_PATH if horizon == C.PRIMARY_HORIZON
                        else MODEL_PATH.with_name(f"forecaster_{horizon}.pkl"))
                if path.exists():
                    self.horizon_models[horizon] = CompoundRiskForecaster.load(path)

            normal = generate_dataset(60, seed=C.GLOBAL_SEED + 7, mix={"normal": 1.0})
            self.detector = AnomalyDetector().fit(build_features(normal))

            self._load_zones()

            from sentinel.rag.store import RegulationStore
            # Anchor on the repo root: the defaults are CWD-relative, so the API
            # would otherwise only find the corpus when launched from one place.
            self.store = RegulationStore(
                corpus_dir=ROOT / "data" / "regulations",
                local_dir=ROOT / "data" / "regulations_local",
            ).build()

            # CV-derived occupancy is opt-in (SENTINEL_VISION=1) and strictly
            # best-effort: a failure here must never block a ready service.
            self._load_vision()

            self.ready = True
        except Exception as e:                       # surface, don't crash the API
            self.error = f"{type(e).__name__}: {e}"

    def _load_zones(self) -> None:
        rng = np.random.default_rng(C.GLOBAL_SEED + 31)
        zones = []
        for i, (zid, name, x, y, scenario, lat, lon, area) in enumerate(ZONE_LAYOUT):
            ep = simulate_episode(scenario, rng, episode_id=i)
            feats = build_features(ep)
            zones.append(ZoneRuntime(
                zone_id=zid, name=name, x=x, y=y,
                lat=lat, lon=lon, area_class=area,
                episode=ep, features=feats,
                proba=self.model.predict_proba(feats),
                anomaly=self.detector.score(feats),
                baseline=baseline_alarm_series(ep),
                horizon_proba={h: m.predict_proba(feats)
                               for h, m in self.horizon_models.items()},
            ))
        self.zones = zones

    # ------------------------------------------------------------------ clock
    @property
    def episode_minutes(self) -> int:
        """Length of the shortest loaded episode -- the clock's wrap point."""
        return min((len(z.features) for z in self.zones), default=1)

    def tick(self, steps: int = 1) -> int:
        """Advance the clock, wrapping back to minute 0 at the end of the episode.

        Wrapping rather than stopping is deliberate: the console is meant to show
        a plant that keeps running, so the shift replays continuously. `laps`
        counts the wraps so the UI can show which pass it is on rather than
        leaving an operator wondering why the numbers reset.
        """
        with self._lock:
            horizon = self.episode_minutes
            total = self.minute + steps
            self.laps += total // horizon
            self.minute = total % horizon
            minute = self.minute
        # Outside the lock: the log is written once per advance, by the clock,
        # so history does not depend on anyone polling /alerts. This is the fix
        # for alerts scrolling away unrecorded -- the queue is a view of *now*,
        # the log is what actually happened.
        self._record_alert_transitions()
        return minute

    def set_minute(self, minute: int) -> int:
        """Seek to a minute. The clock keeps running from wherever it lands."""
        with self._lock:
            self.minute = max(0, min(minute, self.episode_minutes - 1))
            minute = self.minute
        self._record_alert_transitions()
        return minute

    # -------------------------------------------------------------- alert log
    def _append_log(self, event: str, alert: dict, note: str = "") -> None:
        self._log_seq += 1
        self.alert_log.append({
            "seq": self._log_seq,
            "event": event,
            "alert_id": alert["alert_id"],
            "zone_id": alert["zone_id"],
            "zone_name": alert["zone_name"],
            "priority": alert["priority"],
            "risk": alert["risk"],
            "score": alert["score"],
            "lead_time_min": alert.get("lead_time_min"),
            "drivers": alert.get("drivers", []),
            "minute": self.minute,
            "lap": self.laps,
            "note": note,
            "at": datetime.now(timezone.utc),
        })
        if len(self.alert_log) > ALERT_LOG_MAX:
            del self.alert_log[:len(self.alert_log) - ALERT_LOG_MAX]

    def _record_alert_transitions(self) -> None:
        """Diff the live queue against what was standing and log the changes.

        Only *transitions* are recorded. Logging the whole queue every minute
        would bury the four events an investigator cares about under thousands
        of identical rows, which is the same failure as not logging at all.

        Never raises: a logging fault must not stop the plant clock.
        """
        if not self.ready:
            return
        try:
            current = {a["zone_id"]: a for a in self.alerts()}
        except Exception:
            return

        for zone_id, alert in current.items():
            prev = self._open.get(zone_id)
            if prev is None:
                self._append_log("RAISED", alert)
            elif alert["priority"] != prev["priority"]:
                rose = _PRIORITY_RANK[alert["priority"]] > _PRIORITY_RANK[prev["priority"]]
                self._append_log(
                    "ESCALATED" if rose else "DE-ESCALATED", alert,
                    note=f"{prev['priority']} -> {alert['priority']}",
                )

        for zone_id, prev in self._open.items():
            if zone_id not in current:
                held = self.minute - prev.get("minute", self.minute)
                note = "risk fell below the alerting threshold"
                if held > 0:                      # negative means the clock wrapped
                    note += f" after {held} min open"
                self._append_log("CLEARED", prev, note=note)

        # Carry the minute an alert was first raised so CLEARED can report a
        # duration rather than just a timestamp.
        for zone_id, alert in current.items():
            prev = self._open.get(zone_id)
            alert = dict(alert)
            alert["minute"] = prev["minute"] if prev else self.minute
            current[zone_id] = alert
        self._open = current

    def alert_log_entries(self, limit: int = 200,
                          zone_id: str | None = None) -> list[dict]:
        """Most recent transitions first, optionally filtered to one zone."""
        rows = self.alert_log
        if zone_id:
            rows = [r for r in rows if r["zone_id"] == zone_id]
        return list(reversed(rows[-limit:]))

    def clock_state(self) -> dict:
        return {
            "minute": self.minute,
            "episode_minutes": self.episode_minutes,
            "laps": self.laps,
            "running": self.clock_running,
            "seconds_per_minute": self.seconds_per_minute,
        }

    # ------------------------------------------------------------------ state
    def _lead_time(self, z: ZoneRuntime, i: int) -> int | None:
        """Predicted minutes of warning before the incident threshold.

        The horizon set is the mechanism: each model answers "does this cross
        within H minutes?". The *earliest* horizon whose probability clears its
        own tuned threshold is the warning time, because a shorter horizon
        firing means the crossing is nearer.

        This is a forecast. Nothing here reads `incident_onset` -- an earlier
        implementation did, which meant the headline lead-time number was the
        ground-truth label rather than a prediction.
        """
        if self.model is None or z.proba[i] < self.model.threshold:
            return None
        for horizon in sorted(self.horizon_models):
            probs = z.horizon_proba.get(horizon)
            model = self.horizon_models[horizon]
            if probs is not None and probs[i] >= model.threshold:
                return int(horizon)
        # Primary fired but no horizon model did: report the primary's window.
        return int(self.model.horizon)

    # ------------------------------------------------------------------ vision
    def _load_vision(self) -> None:
        """Analyse one real frame per zone. Never raises."""
        self.occupancy = {}
        self.vision_on = False
        try:
            from sentinel.vision.zone_camera import analyse_zones, vision_enabled
            if not vision_enabled():
                return
            self.occupancy = analyse_zones([z.zone_id for z in self.zones])
            self.vision_on = bool(self.occupancy)
        except Exception:
            self.occupancy = {}
            self.vision_on = False

    def vision_report(self) -> dict:
        """Detector output plus its provenance, for the CCTV panel."""
        from sentinel.vision.detector import vision_status
        from sentinel.vision.zone_camera import provenance, vision_enabled
        zones = [o.as_dict() for o in self.occupancy.values()]
        ppe_zones = [z for z in zones if z.get("heads") is not None]
        return {
            "enabled": vision_enabled(),
            "active": self.vision_on,
            "detector": vision_status(),
            **provenance(),
            # Site-level PPE verdict quality. False means the helmet class never
            # fired across any frame, so per-zone "violations" are not evidence
            # of anything and the console says so instead of painting them red.
            "ppe_verified": all(z.get("ppe_verified", True) for z in ppe_zones),
            "zones": zones,
        }

    # -------------------------------------------------------------- geospatial
    def proximate_hazards(self, zone_id: str,
                          radius_m: float = PROXIMITY_RADIUS_M) -> list[dict]:
        """Neighbouring zones within `radius_m` whose gas is elevated and rising.

        This is the spatial question the challenge brief poses directly: a
        hot-work permit may be perfectly acceptable against its *own* zone's
        readings while a neighbouring unit within a few hundred metres is
        venting. Zone-local interlocks cannot see that; distance can.

        Uses real WGS84 coordinates, so the radius is genuine metres.
        """
        from sentinel.rules.engine import COMPOUND_WATCH_LEL

        origin = self._zone(zone_id)
        i = self.minute
        out = []
        for z in self.zones:
            if z.zone_id == origin.zone_id:
                continue
            dist = haversine_m(origin.lat, origin.lon, z.lat, z.lon)
            if dist > radius_m:
                continue
            gas = float(z.episode["gas_sensor"].iloc[i])
            trend = float(z.features["gas_trend"].iloc[i])
            if gas < COMPOUND_WATCH_LEL:
                continue
            out.append({
                "zone_id": z.zone_id,
                "name": z.name,
                "distance_m": round(dist),
                "gas_lel": round(gas, 2),
                "gas_trend": round(trend, 3),
                "rising": trend > 0,
                "area_class": z.area_class.value,
            })
        return sorted(out, key=lambda d: d["distance_m"])

    def site_geo(self) -> dict:
        """Boundary provenance + zone coordinates, for the map layer."""
        from sentinel.geo.site import (
            BOUNDARY_ATTRIBUTION,
            OSM_WAY_ID,
            SITE_NAME,
            boundary_polygon,
        )
        return {
            "site_name": SITE_NAME,
            "osm_way_id": OSM_WAY_ID,
            "attribution": BOUNDARY_ATTRIBUTION,
            "boundary": [[lon, lat] for lon, lat in boundary_polygon()],
            "zone_placement": "representative",
            "proximity_radius_m": PROXIMITY_RADIUS_M,
        }

    def zone_states(self) -> list[dict]:
        i = self.minute
        out = []
        for z in self.zones:
            row = z.features.iloc[[i]]
            ep = z.episode
            drivers = []
            if self.explainer is not None and z.proba[i] >= 0.25:
                from sentinel.ml.explain import _READABLE
                for feat, val in self.explainer.explain_row(row, top=5):
                    drivers.append({"feature": feat,
                                    "label": _READABLE.get(feat, feat),
                                    "contribution": round(float(val), 4)})
            # Occupancy. A detected count may only ever RAISE the number used
            # for decisions -- a camera seeing nobody is not evidence that the
            # zone is empty. Same one-way rule as the permit engine: new
            # evidence can tighten, never loosen.
            simulated_workers = int(ep["workers_in_zone"].iloc[i])
            occ = self.occupancy.get(z.zone_id)
            detected = occ.detected if occ else None
            if detected is None:
                workers, source = simulated_workers, "simulated"
            elif detected >= simulated_workers:
                workers, source = detected, "cv"
            else:
                workers, source = simulated_workers, "cv+floor"

            # PPE gap, carried on the zone so the risk number and the CCTV
            # badge can be shown side by side and reconciled. It deliberately
            # does NOT touch `risk` -- see decision/priority.py for why.
            uncovered = int(occ.uncovered_heads or 0) if occ else 0
            ppe_verified = bool(occ.ppe_verified) if occ else True

            out.append({
                "zone_id": z.zone_id, "name": z.name, "x": z.x, "y": z.y,
                "lat": z.lat, "lon": z.lon,
                "area_class": z.area_class.value,
                "on_site": point_inside_site(z.lat, z.lon),
                "workers_detected": detected,
                "worker_source": source,
                "uncovered_heads": uncovered,
                "ppe_verified": ppe_verified,
                "risk": round(float(z.proba[i]), 4),
                "risk_band": _band(float(z.proba[i])),
                "gas_lel": round(float(ep["gas_sensor"].iloc[i]), 2),
                "gas_trend": round(float(row["gas_trend"].iloc[0]), 3),
                "pressure": round(float(ep["pressure"].iloc[i]), 2),
                "temperature": round(float(ep["temperature"].iloc[i]), 2),
                "anomaly_score": round(float(z.anomaly[i]), 2),
                "workers_in_zone": workers,
                "maintenance_active": bool(ep["maintenance_active"].iloc[i]),
                "hot_work_active": bool(ep["hot_work_permit"].iloc[i]),
                "night_shift": bool(ep["night_shift"].iloc[i]),
                "in_changeover": bool(ep["in_changeover"].iloc[i]),
                "lead_time_min": self._lead_time(z, i),
                "baseline_alarm": bool(z.baseline[i]),
                "drivers": drivers,
            })
        return out

    def zone_history(self, zone_id: str, window: int = 90) -> list[dict]:
        z = self._zone(zone_id)
        i = self.minute
        lo = max(0, i - window + 1)
        ep, f = z.episode, z.features
        return [{
            "minute": int(f["minute"].iloc[k]),
            "gas_lel": round(float(ep["gas_sensor"].iloc[k]), 2),
            "pressure": round(float(ep["pressure"].iloc[k]), 2),
            "temperature": round(float(ep["temperature"].iloc[k]), 2),
            "vibration": round(float(ep["vibration"].iloc[k]), 3),
            "risk": round(float(z.proba[k]), 4),
        } for k in range(lo, i + 1)]

    # -------------------------------------------------------------- what-if
    def simulate(self, zone_id: str, *, gas_delta: float = 0.0,
                 pressure_delta: float = 0.0, temperature_delta: float = 0.0,
                 hot_work: bool | None = None,
                 maintenance: bool | None = None) -> dict:
        """Re-score a zone under operator-supplied overrides.

        This adds no risk logic of its own. It perturbs the raw sensor channels,
        re-runs the same feature engineering and the same trained forecaster used
        everywhere else, and reports what that model says. The counterfactual is
        therefore the real model's opinion, not an approximation of it.
        """
        if self.model is None:
            raise RuntimeError("no model loaded")

        z = self._zone(zone_id)
        i = self.minute

        ep = z.episode.copy()
        n = len(ep)

        # Overrides are a *level shift* applied from well before the current
        # minute, not a ramp and not a rewrite of the whole episode.
        #
        #   - Rewriting all 240 minutes drives time_since_permit far outside the
        #     training range and the model returns nonsense.
        #   - A ramp reaches the current minute mid-slope, which perturbs
        #     gas_std (volatility) as a side effect. gas_std is deliberately
        #     *not* monotone-constrained, so the counterfactual could still show
        #     risk falling as gas rose -- the exact behaviour the constraint
        #     exists to prevent.
        #
        # Shifting the whole feature window uniformly leaves std/trend/roc
        # untouched and moves only the level terms, which are the constrained
        # ones. More gas then provably cannot mean less risk.
        lead_in = max(1, 2 * C.WINDOW_MINUTES)
        start = max(0, i - lead_in)
        idx = np.arange(n)
        active = idx >= start
        shift = active.astype(float)

        if gas_delta:
            ep["gas_sensor"] = (ep["gas_sensor"] + gas_delta * shift).clip(lower=0.0)
        if pressure_delta:
            ep["pressure"] = ep["pressure"] + pressure_delta * shift
        if temperature_delta:
            ep["temperature"] = ep["temperature"] + temperature_delta * shift

        # Flags flip at the same point, so "time since" features stay realistic.
        if hot_work is not None:
            ep["hot_work_permit"] = np.where(
                active, int(bool(hot_work)), ep["hot_work_permit"].to_numpy()
            ).astype(int)
        if maintenance is not None:
            ep["maintenance_active"] = np.where(
                active, int(bool(maintenance)), ep["maintenance_active"].to_numpy()
            ).astype(int)

        feats = build_features(ep)
        proba = self.model.predict_proba(feats)

        row = feats.iloc[[i]]
        drivers = []
        if self.explainer is not None and proba[i] >= 0.25:
            from sentinel.ml.explain import _READABLE
            for feat, val in self.explainer.explain_row(row, top=5):
                drivers.append({"feature": feat,
                                "label": _READABLE.get(feat, feat),
                                "contribution": round(float(val), 4)})

        baseline = baseline_alarm_series(ep)
        return {
            "zone_id": z.zone_id,
            "name": z.name,
            "minute": i,
            "baseline_risk": round(float(z.proba[i]), 4),
            "simulated_risk": round(float(proba[i]), 4),
            "risk_band": _band(float(proba[i])),
            "gas_lel": round(float(ep["gas_sensor"].iloc[i]), 2),
            "pressure": round(float(ep["pressure"].iloc[i]), 2),
            "temperature": round(float(ep["temperature"].iloc[i]), 2),
            "hot_work_active": bool(ep["hot_work_permit"].iloc[i]),
            "maintenance_active": bool(ep["maintenance_active"].iloc[i]),
            "baseline_alarm": bool(baseline[i]),
            "drivers": drivers,
        }

    def simulate_all(self, **overrides) -> list[dict]:
        """Apply the same overrides to every zone."""
        return [self.simulate(z.zone_id, **overrides) for z in self.zones]

    def _zone(self, zone_id: str) -> ZoneRuntime:
        for z in self.zones:
            if z.zone_id == zone_id:
                return z
        raise KeyError(zone_id)

    def alerts(self) -> list[dict]:
        now = datetime.now(timezone.utc)
        items = []
        for s in self.zone_states():
            if s["risk"] < 0.35:
                continue
            nearby = self.proximate_hazards(s["zone_id"])
            pr = prioritise(AlertContext(
                risk=s["risk"], workers_in_zone=s["workers_in_zone"],
                night_shift=s["night_shift"], in_changeover=s["in_changeover"],
                lead_time_min=s["lead_time_min"],
                area_class=s["area_class"],
                proximate_hazards=len([n for n in nearby if n["rising"]]),
                # Only a verified PPE gap moves queue position. An unverified
                # one is still shown in the CCTV panel, but it must not reorder
                # the control room's work on the strength of a detector whose
                # helmet class is not firing.
                uncovered_heads=s["uncovered_heads"] if s["ppe_verified"] else 0,
            ))
            items.append({
                "alert_id": f"{s['zone_id']}-{self.minute:04d}",
                "zone_id": s["zone_id"], "zone_name": s["name"],
                "priority": pr["priority"], "score": pr["score"],
                "risk": s["risk"], "lead_time_min": s["lead_time_min"],
                "drivers": pr["drivers"], "raised_at": now,
            })
        order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        items.sort(key=lambda a: (order[a["priority"]], -a["score"]))
        return items

    def zone_state(self, zone_id: str) -> dict:
        for s in self.zone_states():
            if s["zone_id"] == zone_id:
                return s
        raise KeyError(zone_id)


plant = PlantService()
