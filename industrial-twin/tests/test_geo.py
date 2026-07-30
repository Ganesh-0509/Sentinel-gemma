"""Geospatial layer tests.

Two things matter here:
  1. The coordinates are real -- every zone must fall inside the actual RINL
     site boundary pulled from OpenStreetMap, not merely inside its bounding box.
  2. The spatial permit rule can only ever tighten a decision, exactly like the
     model escalation it sits next to. A new input to the rule engine must not
     open a hole in the safety contract.
"""
from __future__ import annotations

import math

import pytest

from sentinel.api.service import ZONE_LAYOUT
from sentinel.geo.site import (
    AREA_CLASS_FACTOR,
    HazardousAreaClass,
    boundary_polygon,
    haversine_m,
    point_inside_site,
)
from sentinel.rules.engine import (
    HOT_WORK_MAX_LEL,
    PermitRequest,
    ProximateHazard,
    ZoneConditions,
    evaluate_permit,
)

STRICTNESS = {"APPROVED": 0, "CONDITIONAL": 1, "REJECTED": 2}


# ------------------------------------------------------------------ geometry
def test_boundary_is_a_real_closed_polygon():
    ring = boundary_polygon()
    assert len(ring) >= 3, "site boundary missing; data/geo/plant_boundary.geojson"
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    # Visakhapatnam: ~17.6 N, ~83.2 E. Guards against a swapped lat/lon ring.
    assert 17.0 < min(lats) and max(lats) < 18.0
    assert 83.0 < min(lons) and max(lons) < 84.0


def test_every_zone_sits_inside_the_real_site_boundary():
    """Not the bounding box -- the actual polygon."""
    for zid, _name, _x, _y, _scn, lat, lon, _area in ZONE_LAYOUT:
        assert point_inside_site(lat, lon), f"{zid} at {lat},{lon} is outside the site"


def test_haversine_matches_known_separation():
    # One degree of latitude is ~111 km anywhere on the globe.
    d = haversine_m(17.6, 83.2, 18.6, 83.2)
    assert 110_000 < d < 112_000


def test_haversine_is_symmetric_and_zero_on_self():
    assert haversine_m(17.6, 83.2, 17.6, 83.2) == pytest.approx(0.0, abs=1e-6)
    a = haversine_m(17.60, 83.17, 17.64, 83.20)
    b = haversine_m(17.64, 83.20, 17.60, 83.17)
    assert a == pytest.approx(b)


def test_zone_separations_are_plausible_for_one_site():
    """Zones must be far enough apart to be distinct, close enough to be one plant."""
    pts = [(z[0], z[5], z[6]) for z in ZONE_LAYOUT]
    for i, (id_a, la, lo) in enumerate(pts):
        for id_b, lb, lob in pts[i + 1:]:
            d = haversine_m(la, lo, lb, lob)
            assert 100 < d < 12_000, f"{id_a}-{id_b} separated by {d:.0f} m"


def test_a_point_far_offshore_is_not_on_site():
    assert not point_inside_site(17.60, 84.50)


def test_proximity_radius_can_actually_reach_a_neighbour():
    """Guards against the radius being tuned into dead code.

    At 600 m no pair of zones on this real site qualifies, so the whole
    simultaneous-operations rule would silently never fire. If someone tightens
    the radius below the nearest real pair, this fails loudly.
    """
    from sentinel.geo.site import PROXIMITY_RADIUS_M

    pts = [(z[0], z[5], z[6]) for z in ZONE_LAYOUT]
    nearest = min(
        haversine_m(la, lo, lb, lob)
        for i, (_a, la, lo) in enumerate(pts)
        for _b, lb, lob in pts[i + 1:]
    )
    assert PROXIMITY_RADIUS_M >= nearest, (
        f"radius {PROXIMITY_RADIUS_M:.0f} m is below the nearest zone pair "
        f"({nearest:.0f} m) -- the proximity rule can never fire"
    )


def test_proximity_radius_does_not_cover_the_whole_site():
    """The opposite failure: a radius so wide every zone flags every other."""
    from sentinel.geo.site import PROXIMITY_RADIUS_M

    pts = [(z[0], z[5], z[6]) for z in ZONE_LAYOUT]
    widest = max(
        haversine_m(la, lo, lb, lob)
        for i, (_a, la, lo) in enumerate(pts)
        for _b, lb, lob in pts[i + 1:]
    )
    assert PROXIMITY_RADIUS_M < widest, "radius covers the entire site"


# ------------------------------------------------- hazardous area classification
def test_every_zone_has_a_valid_area_class():
    for zid, *_rest, area in [(z[0], z[7]) for z in ZONE_LAYOUT]:
        assert isinstance(area, HazardousAreaClass), zid


def test_area_factors_are_ordered_by_severity():
    """A more hazardous classification must never rank lower."""
    f = AREA_CLASS_FACTOR
    assert (f[HazardousAreaClass.ZONE_0]
            > f[HazardousAreaClass.ZONE_1]
            > f[HazardousAreaClass.ZONE_2]
            >= f[HazardousAreaClass.SAFE])


def test_area_factor_never_reduces_priority():
    """Consequence weighting may raise a score; it must never lower one."""
    assert all(v >= 1.0 for v in AREA_CLASS_FACTOR.values())


# --------------------------------------------------- spatial permit interlock
def _decide(**cond):
    return evaluate_permit(PermitRequest("Hot Work", zone="COB-B"),
                           ZoneConditions(**cond))


def test_adjacent_rising_gas_downgrades_an_otherwise_clean_permit():
    clean = _decide(gas_lel=0.5)
    assert clean.status == "APPROVED"

    withneighbour = _decide(gas_lel=0.5, proximate_hazards=[
        ProximateHazard("BLF-2", distance_m=280, gas_lel=8.0, rising=True)])
    assert withneighbour.status == "CONDITIONAL"
    assert any("BLF-2" in r for r in withneighbour.reasons)
    assert withneighbour.citations


def test_adjacent_gas_that_is_not_rising_does_not_downgrade():
    """A stable neighbour is not a simultaneous-operations hazard."""
    d = _decide(gas_lel=0.5, proximate_hazards=[
        ProximateHazard("BLF-2", distance_m=280, gas_lel=8.0, rising=False)])
    assert d.status == "APPROVED"


def test_spatial_rule_cannot_rescue_a_rejected_permit():
    """The safety contract, extended to the new spatial input."""
    d = _decide(gas_lel=HOT_WORK_MAX_LEL + 5, proximate_hazards=[
        ProximateHazard("BLF-2", distance_m=280, gas_lel=0.0, rising=False)])
    assert d.status == "REJECTED"


@pytest.mark.parametrize("gas", [0.0, 2.0, 4.0, 6.0, 12.0, 40.0])
@pytest.mark.parametrize("rising", [True, False])
def test_proximity_can_only_tighten_never_loosen(gas, rising):
    """Sweep: adding spatial context must never weaken a verdict."""
    without = _decide(gas_lel=gas)
    with_ctx = _decide(gas_lel=gas, proximate_hazards=[
        ProximateHazard("BLF-2", distance_m=300, gas_lel=9.0, rising=rising)])
    assert STRICTNESS[with_ctx.status] >= STRICTNESS[without.status]


def test_nearest_rising_neighbour_is_the_one_reported():
    d = _decide(gas_lel=0.5, proximate_hazards=[
        ProximateHazard("FAR-1", distance_m=900, gas_lel=15.0, rising=True),
        ProximateHazard("NEAR-1", distance_m=120, gas_lel=6.0, rising=True)])
    assert any("NEAR-1" in r for r in d.reasons)
    assert not any("FAR-1" in r for r in d.reasons)


def test_cold_work_is_unaffected_by_adjacent_gas():
    """No ignition source, so the simultaneous-operations rule must not apply."""
    d = evaluate_permit(
        PermitRequest("Cold Work", zone="COB-B"),
        ZoneConditions(gas_lel=0.5, proximate_hazards=[
            ProximateHazard("BLF-2", distance_m=200, gas_lel=8.0, rising=True)]),
    )
    assert d.status == "APPROVED"
