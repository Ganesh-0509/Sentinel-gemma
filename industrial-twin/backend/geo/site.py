"""Site geospatial model -- real coordinates, real distances, hazardous area classes.

Why this module exists
----------------------
Zone positions used to be `x`/`y` on an abstract 0-100 grid. That is a *picture*,
not geography: you cannot compute a distance in metres from it, so you cannot ask
the question the challenge brief actually poses -- "is a hot-work permit being
issued in proximity to an area with elevated gas readings?"

Everything here is anchored on the real plant.

Provenance
----------
* **Site boundary** -- OpenStreetMap way `395219953`, tagged
  `name="Visakapatnam Steel Plant"`, `operator="Rashtriya Ispat Nigam Limited
  (RINL)"`, `landuse=industrial`. Cached at `data/geo/plant_boundary.geojson`.
  (c) OpenStreetMap contributors, ODbL 1.0.

* **Extent cross-check** -- RINL's environmental clearance filing gives the site
  as 17 deg 34'29" - 17 deg 38'49" N, 83 deg 09'23" - 83 deg 14'12" E, 10 m AMSL,
  Gajuwaka, Visakhapatnam. The OSM polygon agrees to within ~0.01 deg, so two
  independent sources corroborate the footprint.

* **Internal unit positions are REPRESENTATIVE, not surveyed.** Unit-level
  geometry for the individual batteries and furnaces is not publicly mapped -- an
  Overpass query inside the boundary returns only a handful of unnamed building
  polygons. Zone coordinates here are placed inside the real boundary in a
  plausible arrangement. They are honest about being a model of the plant, not a
  survey of it, and the API reports that distinction rather than hiding it.

Hazardous area classification follows IEC 60079-10-1 / OISD practice. It is an
engineering judgement per site; the values here are reasoned defaults for an
integrated steel plant, and are configuration rather than model output.
"""
from __future__ import annotations

import json
import math
from enum import Enum
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BOUNDARY_PATH = ROOT / "data" / "geo" / "plant_boundary.geojson"

# Source identifiers, surfaced through the API so the map can attribute itself.
OSM_WAY_ID = 395219953
SITE_NAME = "Visakhapatnam Steel Plant (RINL)"
BOUNDARY_SOURCE = "OpenStreetMap contributors, ODbL 1.0"
BOUNDARY_ATTRIBUTION = f"OSM way {OSM_WAY_ID} (c) OpenStreetMap contributors, ODbL 1.0"


class HazardousAreaClass(str, Enum):
    """IEC 60079-10-1 zone classification for explosive gas atmospheres.

    ZONE_0  explosive atmosphere present continuously or for long periods
    ZONE_1  likely to occur in normal operation
    ZONE_2  unlikely in normal operation, and short-lived if it occurs
    SAFE    no classified release source
    """

    ZONE_0 = "ZONE_0"
    ZONE_1 = "ZONE_1"
    ZONE_2 = "ZONE_2"
    SAFE = "SAFE"


# Consequence weighting applied at the DECISION layer, never inside the hazard
# model. A zone where a flammable atmosphere is expected in normal operation
# deserves a higher queue position than an identical reading in an unclassified
# area -- but the probability of an incident is the model's business alone.
# Same separation of concerns as exposure and urgency in decision/priority.py.
AREA_CLASS_FACTOR = {
    HazardousAreaClass.ZONE_0: 1.35,
    HazardousAreaClass.ZONE_1: 1.20,
    HazardousAreaClass.ZONE_2: 1.05,
    HazardousAreaClass.SAFE: 1.00,
}

# Radius within which a neighbouring zone's gas condition is treated as relevant
# to a permit decision.
#
# Calibrated against the real geometry, not guessed. The site spans ~6 km and
# zone centres are 1.1-6.0 km apart (nearest pair: BYP-1 to GAS-H at 1077 m),
# which is what an integrated steel plant of 3240 ha actually looks like. At
# 1500 m the rule captures immediately-adjacent production units -- the coke
# oven -> by-product -> gas holder train that physically shares gas handling --
# without collapsing the whole site into one interlock.
#
# A tighter radius would be dead code here: at 600 m no pair of zones qualifies.
PROXIMITY_RADIUS_M = 1500.0

_EARTH_RADIUS_M = 6_371_000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres between two WGS84 points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_RADIUS_M * math.asin(math.sqrt(a))


@lru_cache(maxsize=1)
def boundary_polygon() -> list[tuple[float, float]]:
    """The site boundary as [(lon, lat), ...]. Empty if the cache is absent."""
    if not BOUNDARY_PATH.exists():
        return []
    gj = json.loads(BOUNDARY_PATH.read_text(encoding="utf-8"))
    try:
        ring = gj["features"][0]["geometry"]["coordinates"][0]
    except (KeyError, IndexError):
        return []
    return [(float(lon), float(lat)) for lon, lat in ring]


def point_inside_site(lat: float, lon: float) -> bool:
    """Ray-casting point-in-polygon against the real site boundary.

    Returns False when the boundary cache is missing -- callers treat that as
    "unknown", never as a safety signal.
    """
    ring = boundary_polygon()
    if len(ring) < 3:
        return False
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            x_at = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
            if lon < x_at:
                inside = not inside
    return inside
