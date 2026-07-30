/**
 * Factory-wide data model — building identities, safety zones, tank labels, pipeline types.
 * Every physical asset has a typed identity so the AI layer can reason about it.
 */

// ─── Safety Zones ─────────────────────────────────────────────────────────────
export type ZoneId = "zone_a" | "zone_b" | "zone_c" | "zone_d";

export interface SafetyZone {
  id: ZoneId;
  name: string;
  label: string;
  color: number; // 0xRRGGBB for 3-D overlays
  cssColor: string; // for UI panels
  riskLevel: number; // 0-100
  description: string;
  bounds: { x: number; z: number; w: number; d: number }; // ground rectangle
}

export const SAFETY_ZONES: SafetyZone[] = [
  {
    id: "zone_a",
    name: "Tank Farm",
    label: "🟩 Zone A — Tank Farm",
    color: 0x22c55e,
    cssColor: "#22c55e",
    riskLevel: 72,
    description: "Fuel & chemical storage tanks. High flammability risk.",
    bounds: { x: -95, z: 85, w: 80, d: 60 },
  },
  {
    id: "zone_b",
    name: "Processing",
    label: "🟨 Zone B — Processing",
    color: 0xf59e0b,
    cssColor: "#f59e0b",
    riskLevel: 58,
    description: "Refinery processing, distillation, heat exchangers.",
    bounds: { x: 0, z: -5, w: 90, d: 70 },
  },
  {
    id: "zone_c",
    name: "Boiler & Cooling",
    label: "🟧 Zone C — Boiler & Cooling",
    color: 0xf97316,
    cssColor: "#f97316",
    riskLevel: 82,
    description: "Boiler house, cooling towers. High temperature risk.",
    bounds: { x: 75, z: 65, w: 70, d: 70 },
  },
  {
    id: "zone_d",
    name: "Hazardous Chemical",
    label: "🟥 Zone D — Hazardous Chemical",
    color: 0xef4444,
    cssColor: "#ef4444",
    riskLevel: 92,
    description: "Pressure vessels, chemical piping. Toxic & explosive materials.",
    bounds: { x: 55, z: -70, w: 80, d: 50 },
  },
];

// ─── Building Identities ──────────────────────────────────────────────────────
export type BuildingType =
  | "Boiler"
  | "ControlRoom"
  | "Warehouse"
  | "Maintenance"
  | "PumpHouse"
  | "CoolingPlant"
  | "Refinery"
  | "SecurityBooth"
  | "LoadingDock"
  | "ParkingArea";

export interface BuildingIdentity {
  id: string;
  name: string;
  type: BuildingType;
  zone: ZoneId;
  description: string;
  position: { x: number; y: number; z: number };
}

export const BUILDINGS: BuildingIdentity[] = [
  {
    id: "boiler_house",
    name: "Boiler House",
    type: "Boiler",
    zone: "zone_c",
    description: "Main steam generation facility. Contains two high-pressure boilers.",
    position: { x: 60, y: 16, z: 40 },
  },
  {
    id: "control_room",
    name: "Control Room",
    type: "ControlRoom",
    zone: "zone_b",
    description: "Central AI brain — monitors all sensors, cameras, and AI predictions.",
    position: { x: -80, y: 12, z: -80 },
  },
  {
    id: "warehouse",
    name: "Warehouse",
    type: "Warehouse",
    zone: "zone_b",
    description: "Parts, equipment, and materials storage.",
    position: { x: 70, y: 14, z: -80 },
  },
  {
    id: "maintenance_workshop",
    name: "Maintenance Workshop",
    type: "Maintenance",
    zone: "zone_b",
    description: "Equipment repair and tool storage workshop.",
    position: { x: -70, y: 14, z: -30 },
  },
  {
    id: "pump_house",
    name: "Pump House",
    type: "PumpHouse",
    zone: "zone_b",
    description: "Central water and chemical pumping station.",
    position: { x: -45, y: 9, z: 40 },
  },
  {
    id: "cooling_tower",
    name: "Cooling Tower A",
    type: "CoolingPlant",
    zone: "zone_c",
    description: "Primary cooling tower for process water recirculation.",
    position: { x: 90, y: 28, z: 90 },
  },
  {
    id: "cooling_tower_2",
    name: "Cooling Tower B",
    type: "CoolingPlant",
    zone: "zone_c",
    description: "Secondary cooling tower — backup capacity.",
    position: { x: 115, y: 22, z: 60 },
  },
  {
    id: "refinery_unit",
    name: "Refinery Processing Unit",
    type: "Refinery",
    zone: "zone_b",
    description: "Core refinery complex with distillation columns and reactors.",
    position: { x: 0, y: 28, z: 0 },
  },
  {
    id: "security_booth",
    name: "Security Booth",
    type: "SecurityBooth",
    zone: "zone_b",
    description: "Main entry checkpoint and visitor registration.",
    position: { x: -22, y: 7, z: -122 },
  },
  {
    id: "loading_dock",
    name: "Loading Dock",
    type: "LoadingDock",
    zone: "zone_b",
    description: "Material loading/unloading bay for trucks.",
    position: { x: 70, y: 4, z: -55 },
  },
];

// ─── Tank Labels ──────────────────────────────────────────────────────────────
export interface TankInfo {
  id: string;
  name: string;
  contents: string;
  capacity: string;
  fillLevel: number; // 0–100 %
  zone: ZoneId;
  position: { x: number; y: number; z: number };
  riskLevel: number;
}

export const TANKS: TankInfo[] = [
  {
    id: "tank_a",
    name: "Tank A",
    contents: "Methane",
    capacity: "5 000 m³",
    fillLevel: 78,
    zone: "zone_a",
    position: { x: -115, y: 18, z: 80 },
    riskLevel: 85,
  },
  {
    id: "tank_b",
    name: "Tank B",
    contents: "Diesel",
    capacity: "5 000 m³",
    fillLevel: 62,
    zone: "zone_a",
    position: { x: -85, y: 18, z: 100 },
    riskLevel: 45,
  },
  {
    id: "tank_c",
    name: "Tank C",
    contents: "Water",
    capacity: "5 000 m³",
    fillLevel: 91,
    zone: "zone_a",
    position: { x: -115, y: 18, z: 108 },
    riskLevel: 12,
  },
  {
    id: "tank_d",
    name: "Tank D",
    contents: "Chemical X",
    capacity: "2 000 m³",
    fillLevel: 34,
    zone: "zone_a",
    position: { x: -70, y: 12, z: 75 },
    riskLevel: 78,
  },
  {
    id: "tank_e",
    name: "Tank E",
    contents: "Ammonia",
    capacity: "1 500 m³",
    fillLevel: 55,
    zone: "zone_a",
    position: { x: -55, y: 11, z: 92 },
    riskLevel: 68,
  },
];

// ─── Pipeline Types ───────────────────────────────────────────────────────────
export type PipelineType = "gas" | "water" | "steam" | "chemical";

export interface PipelineConfig {
  type: PipelineType;
  color: number;
  label: string;
  emissive: number;
}

export const PIPELINE_COLORS: Record<PipelineType, PipelineConfig> = {
  gas: { type: "gas", color: 0xeab308, label: "Gas", emissive: 0x544000 },
  water: { type: "water", color: 0x3b82f6, label: "Water", emissive: 0x001a44 },
  steam: { type: "steam", color: 0xef4444, label: "Steam", emissive: 0x440000 },
  chemical: { type: "chemical", color: 0x22c55e, label: "Chemical", emissive: 0x004400 },
};

// ─── Pipe routes with their type ──────────────────────────────────────────────
export interface PipeRoute {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  type: PipelineType;
}

export const PIPE_ROUTES: PipeRoute[] = [
  { from: { x: -100, y: 0, z: 80 }, to: { x: -30, y: 0, z: 20 }, type: "gas" },
  { from: { x: -30, y: 0, z: 20 }, to: { x: 30, y: 0, z: 20 }, type: "steam" },
  { from: { x: 30, y: 0, z: 20 }, to: { x: 80, y: 0, z: 40 }, type: "steam" },
  { from: { x: 30, y: 0, z: 20 }, to: { x: 50, y: 0, z: -60 }, type: "chemical" },
  { from: { x: -30, y: 0, z: 20 }, to: { x: -70, y: 0, z: -20 }, type: "water" },
  { from: { x: 80, y: 0, z: 40 }, to: { x: 90, y: 0, z: 80 }, type: "water" },
];
