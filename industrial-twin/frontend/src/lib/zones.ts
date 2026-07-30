import type { ZoneState } from "./api-types";

/** Highest-risk zone — the sensible default selection on per-zone pages. */
export function riskiestZoneId(zones: ZoneState[]): string | undefined {
  if (zones.length === 0) return undefined;
  return zones.reduce((a, b) => (b.risk > a.risk ? b : a)).zone_id;
}
