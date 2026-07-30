/**
 * Zone picker used by the per-zone pages.
 *
 * The backend has no notion of a "selected" zone — selection is purely client
 * state, so this is a plain controlled <select> over whatever /zones returned.
 */
import type { ZoneState } from "@/lib/api-types";

export function ZoneSelect({
  zones,
  value,
  onChange,
}: {
  zones: ZoneState[];
  value: string;
  onChange: (zoneId: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Select zone"
      className="rounded-sm border border-border bg-background/60 px-2 py-1 text-[11px] text-foreground outline-none focus:border-primary"
    >
      {zones.map((z) => (
        <option key={z.zone_id} value={z.zone_id}>
          {z.zone_id} · {z.name}
        </option>
      ))}
    </select>
  );
}
