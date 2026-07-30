import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip, StatusDot } from "@/components/panel";
import { ErrorState, Loading, QueryBoundary } from "@/components/data-state";
import { bandTone, riskPct, useEvaluatePermit, useZones } from "@/lib/queries";
import type { PermitStatus, PermitType, ZoneState } from "@/lib/api-types";
import { ArrowRight, FileText } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/permit-intelligence")({
  head: () => ({
    meta: [
      { title: "Permit Intelligence · Sentinel-Gemma" },
      {
        name: "description",
        content:
          "AI-governed permit-to-work review with predicted risk, violation reasoning, and recommended action.",
      },
    ],
  }),
  component: PermitIntelligence,
});

const PERMIT_TYPES: PermitType[] = ["Hot Work", "Confined Space", "Cold Work", "Electrical"];

const statusTone = (s: PermitStatus): "success" | "warn" | "danger" =>
  s === "APPROVED" ? "success" : s === "CONDITIONAL" ? "warn" : "danger";

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "warn" | "danger" | "muted";
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 font-medium">
        {tone && <StatusDot tone={tone} />}
        <span className="mono">{value}</span>
      </div>
    </div>
  );
}

function Conditions({ zone }: { zone: ZoneState }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-[12px]">
      <Field
        label="Gas % LEL"
        value={`${zone.gas_lel.toFixed(2)}%`}
        tone={zone.gas_lel >= 5 ? "danger" : zone.gas_lel >= 2 ? "warn" : "success"}
      />
      <Field
        label="Gas trend"
        value={`${zone.gas_trend > 0 ? "+" : ""}${zone.gas_trend.toFixed(3)} %LEL/min`}
        tone={zone.gas_trend > 0 ? "warn" : "success"}
      />
      <Field
        label="Maintenance"
        value={zone.maintenance_active ? "ACTIVE" : "none"}
        tone={zone.maintenance_active ? "warn" : "muted"}
      />
      <Field
        label="Workers in zone"
        value={String(zone.workers_in_zone)}
        tone={zone.workers_in_zone > 0 ? "warn" : "muted"}
      />
    </div>
  );
}

function PermitIntelligence() {
  const zones = useZones();
  const [zoneId, setZoneId] = useState("");
  const [permitType, setPermitType] = useState<PermitType>("Hot Work");
  const evaluate = useEvaluatePermit();

  // Default to the first zone the backend reports, once it arrives.
  useEffect(() => {
    if (!zoneId && zones.data?.length) setZoneId(zones.data[0].zone_id);
  }, [zoneId, zones.data]);

  const zone = zones.data?.find((z) => z.zone_id === zoneId);
  const decision = evaluate.data;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      <Panel
        title="Permit Request"
        subtitle="Evaluated against live zone conditions and deterministic interlocks"
        className="lg:col-span-5"
      >
        <QueryBoundary
          query={zones}
          loadingLabel="Loading zones"
          emptyLabel="No zones reported"
          isEmpty={(z) => z.length === 0}
        >
          {(list) => (
            <div className="space-y-3 text-[12px]">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Zone
                </div>
                <select
                  value={zoneId}
                  onChange={(e) => {
                    setZoneId(e.target.value);
                    evaluate.reset();
                  }}
                  className="h-9 w-full rounded-md border border-border bg-background/50 px-2 text-[12px] focus:outline-none"
                >
                  {list.map((z) => (
                    <option key={z.zone_id} value={z.zone_id}>
                      {z.zone_id} · {z.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Permit type
                </div>
                <div className="flex flex-wrap gap-1">
                  {PERMIT_TYPES.map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        setPermitType(t);
                        evaluate.reset();
                      }}
                      className={`rounded-sm border px-2 py-1 text-[11px] ${
                        permitType === t
                          ? "border-primary/40 bg-primary/15 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={() =>
                  zoneId && evaluate.mutate({ permit_type: permitType, zone_id: zoneId })
                }
                disabled={!zoneId || evaluate.isPending}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
              >
                Evaluate permit <ArrowRight className="h-3 w-3" />
              </button>

              {zone && (
                <div className="space-y-2 border-t border-border pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Live conditions · {zone.zone_id}
                    </span>
                    <Chip tone={bandTone(zone.risk_band)}>
                      {zone.risk_band} · {riskPct(zone.risk)}%
                    </Chip>
                  </div>
                  <Conditions zone={zone} />
                </div>
              )}
            </div>
          )}
        </QueryBoundary>
      </Panel>

      <Panel
        title="Permit Decision"
        subtitle={decision ? `${permitType} · ${zoneId}` : "No evaluation yet"}
        actions={decision && <Chip tone={statusTone(decision.status)}>{decision.status}</Chip>}
        className="lg:col-span-7 min-h-[500px]"
      >
        {evaluate.isPending ? (
          <Loading label="Evaluating permit" />
        ) : evaluate.error ? (
          <ErrorState error={evaluate.error} onRetry={() => evaluate.reset()} />
        ) : !decision ? (
          <p className="px-1 py-6 text-[12px] text-muted-foreground">
            Select a zone and permit type, then evaluate. The decision comes from the backend's
            deterministic interlocks; the risk model may only make the outcome stricter.
          </p>
        ) : (
          <div className="space-y-3 text-[12px]">
            <div
              className={`rounded-md border p-3 ${
                decision.status === "APPROVED"
                  ? "border-success/40 bg-success/10"
                  : decision.status === "CONDITIONAL"
                    ? "border-warning/40 bg-warning/10"
                    : "border-destructive/40 bg-destructive/10"
              }`}
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Status
              </div>
              <div className="mono mt-0.5 text-2xl font-semibold">{decision.status}</div>
            </div>

            <div className="rounded-md border border-border bg-background/40 p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Reasons
              </div>
              {decision.reasons.length > 0 ? (
                <ol className="mt-1.5 list-decimal space-y-1 pl-4 leading-relaxed">
                  {decision.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ol>
              ) : (
                <p className="mt-1.5 text-muted-foreground">No reasons returned.</p>
              )}
            </div>

            {/* The audit trail. Previously an approved permit showed the single
                line "All gas/oxygen readings within permit limits", which is
                indistinguishable from the engine not having run. Every check is
                now listed with the reading it was made on. */}
            <div className="rounded-md border border-border bg-background/40 p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Interlocks evaluated ({decision.checks.length})
              </div>
              {decision.checks.length > 0 ? (
                <ul className="mono mt-1.5 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                  {decision.checks.map((c) => (
                    <li key={c} className="flex gap-2">
                      <span className="shrink-0 text-success">✓</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-muted-foreground">No checks reported.</p>
              )}
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Citations
              </div>
              {decision.citations.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {decision.citations.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-0.5 text-[11px]"
                    >
                      <FileText className="h-3 w-3 text-primary" />
                      {c}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-muted-foreground">
                  No citations returned for this decision.
                </p>
              )}
            </div>

            {zone && (
              <div className="rounded-md border border-border bg-background/40 p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Conditions that drove the decision
                </div>
                <Conditions zone={zone} />
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
