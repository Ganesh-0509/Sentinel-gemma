import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip, StatusDot } from "@/components/panel";
import { QueryBoundary } from "@/components/data-state";
import { ZoneSelect } from "@/components/zone-select";
import { useState } from "react";
import { bandTone, riskPct, useProximity, useSiteGeo, useVision, useZones } from "@/lib/queries";
import type { HazardousAreaClass, ZoneState } from "@/lib/api-types";

export const Route = createFileRoute("/geospatial")({
  head: () => ({
    meta: [
      { title: "Geospatial & Vision · SentinelAI" },
      {
        name: "description",
        content:
          "Real plant coordinates, IEC 60079-10-1 hazardous area classification, " +
          "simultaneous-operations proximity, and detector-derived occupancy.",
      },
    ],
  }),
  component: Geospatial,
});

/** IEC 60079-10-1 classes, worst first. */
const AREA_LABEL: Record<HazardousAreaClass, string> = {
  ZONE_0: "Zone 0 — explosive atmosphere continuously present",
  ZONE_1: "Zone 1 — likely in normal operation",
  ZONE_2: "Zone 2 — unlikely, short-lived",
  SAFE: "Unclassified",
};

function areaTone(a: HazardousAreaClass): "danger" | "warn" | "success" | "muted" {
  return a === "ZONE_0" ? "danger" : a === "ZONE_1" ? "warn" : a === "ZONE_2" ? "success" : "muted";
}

function Geospatial() {
  const zones = useZones();
  const geo = useSiteGeo();
  const vision = useVision();
  const [zoneId, setZoneId] = useState<string | undefined>(undefined);

  const list = zones.data ?? [];
  const activeId = zoneId ?? [...list].sort((a, b) => b.risk - a.risk)[0]?.zone_id;
  const active = list.find((z) => z.zone_id === activeId);
  const proximity = useProximity(activeId);

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      {/* ── SITE PROVENANCE ─────────────────────────────────────────────── */}
      <Panel
        title="Site Reference"
        subtitle="Where the coordinates come from, and what is modelled"
        className="lg:col-span-5"
      >
        <QueryBoundary query={geo} loadingLabel="Loading site boundary">
          {(g) => (
            <div className="space-y-3 text-[12px]">
              <Field label="Site">{g.site_name}</Field>
              <Field label="Boundary source">
                <a
                  href={`https://www.openstreetmap.org/way/${g.osm_way_id}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mono text-primary hover:underline"
                >
                  OSM way {g.osm_way_id}
                </a>
                <span className="ml-2 text-muted-foreground">{g.boundary.length} nodes</span>
              </Field>
              <Field label="Licence">
                <span className="text-muted-foreground">{g.attribution}</span>
              </Field>
              <Field label="Unit placement">
                <Chip tone={g.zone_placement === "surveyed" ? "success" : "warn"}>
                  {g.zone_placement}
                </Chip>
              </Field>
              <Field label="Proximity radius">
                <span className="mono">{g.proximity_radius_m} m</span>
              </Field>

              <p className="rounded-md border border-border bg-background/40 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                The site boundary is real, externally-sourced open data, cross-checked against
                RINL&rsquo;s environmental clearance filing.{" "}
                <strong className="text-foreground">
                  Internal unit positions are representative
                </strong>{" "}
                — unit-level geometry for the individual batteries is not publicly mapped, and this
                system reports that rather than implying survey accuracy it does not have.
              </p>
            </div>
          )}
        </QueryBoundary>
      </Panel>

      {/* ── HAZARDOUS AREA CLASSIFICATION ───────────────────────────────── */}
      <Panel
        title="Hazardous Area Classification"
        subtitle="IEC 60079-10-1 · raises alert priority, never the hazard estimate"
        className="lg:col-span-7"
        padded={false}
        bodyClassName="overflow-y-auto scrollbar-thin"
      >
        <QueryBoundary
          query={zones}
          loadingLabel="Loading zones"
          isEmpty={(z: ZoneState[]) => z.length === 0}
          emptyLabel="No zones reported"
        >
          {(data) => (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-panel text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left font-medium">Zone</th>
                  <th className="px-3 py-2 text-left font-medium">Coordinates</th>
                  <th className="px-3 py-2 text-left font-medium">Area class</th>
                  <th className="px-3 py-2 text-right font-medium">Risk</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.map((z) => (
                  <tr
                    key={z.zone_id}
                    onClick={() => setZoneId(z.zone_id)}
                    className={`cursor-pointer transition-colors hover:bg-muted/40 ${
                      z.zone_id === activeId ? "bg-primary/8" : ""
                    }`}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <StatusDot tone={bandTone(z.risk_band)} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{z.name}</div>
                          <div className="mono text-[10px] text-muted-foreground">
                            {z.zone_id}
                            {!z.on_site && <span className="ml-1 text-destructive">off-site!</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="mono px-3 py-2 text-[11px] text-muted-foreground">
                      {z.lat.toFixed(5)}°N
                      <br />
                      {z.lon.toFixed(5)}°E
                    </td>
                    <td className="px-3 py-2">
                      <Chip tone={areaTone(z.area_class)}>{z.area_class.replace("_", " ")}</Chip>
                    </td>
                    <td className="mono px-3 py-2 text-right font-semibold">{riskPct(z.risk)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryBoundary>
      </Panel>

      {/* ── SIMULTANEOUS OPERATIONS ─────────────────────────────────────── */}
      <Panel
        title="Simultaneous Operations"
        subtitle="Neighbouring units venting within real distance — invisible to a zone-local alarm"
        className="lg:col-span-6"
        actions={<ZoneSelect zones={list} value={activeId ?? ""} onChange={setZoneId} />}
      >
        {active && (
          <p className="mb-3 text-[11px] text-muted-foreground">
            <span className="mono text-foreground">{active.zone_id}</span> own gas{" "}
            <span className="mono text-foreground">{active.gas_lel.toFixed(2)}% LEL</span> ·{" "}
            {AREA_LABEL[active.area_class]}
          </p>
        )}
        <QueryBoundary
          query={proximity}
          loadingLabel="Checking neighbouring zones"
          isEmpty={(h) => h.length === 0}
          emptyLabel="No neighbouring zone within range is above the watch threshold."
        >
          {(hazards) => (
            <ul className="space-y-2">
              {hazards.map((h) => (
                <li
                  key={h.zone_id}
                  className={`rounded-md border p-2.5 ${
                    h.rising
                      ? "border-destructive/40 bg-destructive/8"
                      : "border-border bg-background/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{h.name}</span>
                    <span className="mono text-[11px] text-muted-foreground">
                      {h.distance_m} m away
                    </span>
                  </div>
                  <div className="mono mt-1 flex flex-wrap gap-2 text-[11px]">
                    <span>{h.gas_lel.toFixed(2)}% LEL</span>
                    <span className={h.rising ? "text-destructive" : "text-muted-foreground"}>
                      {h.gas_trend > 0 ? "+" : ""}
                      {h.gas_trend.toFixed(3)}/min {h.rising ? "· RISING" : "· stable"}
                    </span>
                    <Chip tone={areaTone(h.area_class)}>{h.area_class.replace("_", " ")}</Chip>
                  </div>
                  {h.rising && (
                    <p className="mt-1.5 text-[11px] text-destructive">
                      Hot-work permits here are downgraded to CONDITIONAL while this neighbour is
                      rising.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </Panel>

      {/* ── VISION / OCCUPANCY ──────────────────────────────────────────── */}
      <Panel
        title="Detector-Derived Occupancy"
        subtitle="Person counts from a real detector on real industrial imagery"
        className="lg:col-span-6"
      >
        <QueryBoundary query={vision} loadingLabel="Loading detector status">
          {(v) =>
            !v.active ? (
              <div className="space-y-2 text-[12px]">
                <Chip tone="muted">inactive</Chip>
                <p className="text-muted-foreground">
                  Vision is off, so occupancy comes from the simulator. Start the API with{" "}
                  <code className="mono rounded bg-muted px-1">SENTINEL_VISION=1</code> to enable
                  it.
                </p>
                {v.detector?.error && (
                  <p className="mono text-[11px] text-destructive">{v.detector.error}</p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <Chip tone="success">active</Chip>
                  <span className="mono text-muted-foreground">
                    {v.detector.weights} · conf ≥ {v.detector.min_confidence}
                  </span>
                  <Chip tone="warn">{v.frame_binding}</Chip>
                  {!v.ppe_verified && <Chip tone="muted">PPE unverified</Chip>}
                </div>

                {/* The reported confusion: a green PPE badge next to 96% risk,
                    a red one next to 1%. They are not the same measurement and
                    were never meant to agree — so say so, here, rather than
                    leaving an operator to infer that one of them is broken. */}
                <p className="rounded-md border border-border bg-background/40 p-2.5 text-[10px] leading-relaxed text-muted-foreground">
                  <strong className="text-foreground">Risk and PPE are separate readings.</strong>{" "}
                  Risk is P(incident) from the sensor model — gas, pressure, temperature, vibration.
                  PPE is what the camera sees people wearing. A zone can be 96% risk with correct
                  PPE, or 1% risk with a bare head, because a helmet does not change how likely a
                  release is; it changes how badly one ends. PPE therefore feeds{" "}
                  <strong className="text-foreground">alert priority</strong> and can downgrade a
                  permit, and is deliberately kept out of the risk model.
                </p>

                {!v.ppe_verified && (
                  <p className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[10px] leading-relaxed text-warning">
                    The helmet class did not fire on a single frame in this run, so &ldquo;uncovered
                    heads&rdquo; here is far more likely an under-trained detector than a site-wide
                    PPE failure. Counts are still shown, but they are labelled unverified and are
                    not moving anything in the alert queue.
                  </p>
                )}

                <ul className="space-y-1.5">
                  {v.zones.map((z) => {
                    const zone = list.find((s) => s.zone_id === z.zone_id);
                    const floored = zone?.worker_source === "cv+floor";
                    return (
                      <li
                        key={z.zone_id}
                        className="rounded-md border border-border bg-background/40 p-2 text-[11px]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5">
                            <span className="mono font-medium text-foreground">{z.zone_id}</span>
                            {/* Show the zone's risk band right here, so the two
                                numbers are read together instead of being
                                compared across two panels. */}
                            {zone && (
                              <Chip tone={bandTone(zone.risk_band)}>
                                {zone.risk_band} · {riskPct(zone.risk)}% risk
                              </Chip>
                            )}
                          </span>
                          <span className="mono text-muted-foreground">
                            detected {z.detected} → used {zone?.workers_in_zone ?? "—"}
                          </span>
                        </div>
                        <div className="mono mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="truncate">{z.frame}</span>
                          {z.confidences.length > 0 && (
                            <span>[{z.confidences.map((c) => c.toFixed(2)).join(", ")}]</span>
                          )}
                          <span>{z.inference_ms.toFixed(0)}ms</span>
                        </div>
                        {z.heads !== null && (
                          <div className="mono mt-1 flex flex-wrap items-center gap-2 text-[10px]">
                            <span className="text-muted-foreground">
                              heads {z.heads} · helmets {z.helmets} · vests {z.vests}
                            </span>
                            {!z.ppe_verified ? (
                              // Not a violation and not a clean bill: the
                              // detector could not tell. Painting this red on
                              // every zone is how the badge became noise.
                              <Chip tone="muted">
                                PPE unverified
                                {z.uncovered_heads
                                  ? ` · ${z.uncovered_heads} head(s) unmatched`
                                  : ""}
                              </Chip>
                            ) : z.ppe_violation ? (
                              <Chip tone="danger">
                                {z.uncovered_heads} uncovered head
                                {z.uncovered_heads === 1 ? "" : "s"}
                              </Chip>
                            ) : (
                              <Chip tone="success">PPE ok</Chip>
                            )}
                          </div>
                        )}
                        {floored && (
                          <p className="mt-1 text-[10px] text-warning">
                            Detector saw fewer than the floor — floor kept. A camera seeing nobody
                            is not evidence a zone is empty.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>

                <p className="rounded-md border border-border bg-background/40 p-2.5 text-[10px] leading-relaxed text-muted-foreground">
                  {v.frame_source} · {v.frame_licence}. There is no live camera at this site: frames
                  are bound to zones deterministically so the demo is reproducible. Detection may{" "}
                  <strong className="text-foreground">raise</strong> occupancy, never lower it.
                </p>
              </div>
            )
          }
        </QueryBoundary>
      </Panel>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-32 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
