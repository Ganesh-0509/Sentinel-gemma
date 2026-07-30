/**
 * Emergency equipment locations and evacuation routes.
 */

export interface EmergencyEquipment {
  id: string;
  type:
    | "fire_extinguisher"
    | "fire_station"
    | "medical_room"
    | "emergency_exit"
    | "alarm_pole"
    | "assembly_point";
  name: string;
  icon: string;
  position: { x: number; y: number; z: number };
}

export const EMERGENCY_EQUIPMENT: EmergencyEquipment[] = [
  // Fire Station
  {
    id: "fire_station",
    type: "fire_station",
    name: "Fire Station",
    icon: "🚒",
    position: { x: -130, y: 0, z: -80 },
  },

  // Medical Room
  {
    id: "medical_room",
    type: "medical_room",
    name: "Medical Room",
    icon: "🚑",
    position: { x: -95, y: 0, z: -80 },
  },

  // Fire Extinguishers (8 locations)
  {
    id: "fe_01",
    type: "fire_extinguisher",
    name: "Extinguisher — Tank Farm",
    icon: "🧯",
    position: { x: -100, y: 0, z: 95 },
  },
  {
    id: "fe_02",
    type: "fire_extinguisher",
    name: "Extinguisher — Boiler",
    icon: "🧯",
    position: { x: 45, y: 0, z: 40 },
  },
  {
    id: "fe_03",
    type: "fire_extinguisher",
    name: "Extinguisher — Warehouse",
    icon: "🧯",
    position: { x: 50, y: 0, z: -80 },
  },
  {
    id: "fe_04",
    type: "fire_extinguisher",
    name: "Extinguisher — Control Room",
    icon: "🧯",
    position: { x: -65, y: 0, z: -80 },
  },
  {
    id: "fe_05",
    type: "fire_extinguisher",
    name: "Extinguisher — Refinery",
    icon: "🧯",
    position: { x: 25, y: 0, z: 5 },
  },
  {
    id: "fe_06",
    type: "fire_extinguisher",
    name: "Extinguisher — Pump House",
    icon: "🧯",
    position: { x: -35, y: 0, z: 40 },
  },
  {
    id: "fe_07",
    type: "fire_extinguisher",
    name: "Extinguisher — Cooling",
    icon: "🧯",
    position: { x: 100, y: 0, z: 80 },
  },
  {
    id: "fe_08",
    type: "fire_extinguisher",
    name: "Extinguisher — Dock",
    icon: "🧯",
    position: { x: 85, y: 0, z: -55 },
  },

  // Emergency Exits (4 corners)
  {
    id: "exit_01",
    type: "emergency_exit",
    name: "Exit — North West",
    icon: "🚪",
    position: { x: -155, y: 0, z: 0 },
  },
  {
    id: "exit_02",
    type: "emergency_exit",
    name: "Exit — North East",
    icon: "🚪",
    position: { x: 155, y: 0, z: 0 },
  },
  {
    id: "exit_03",
    type: "emergency_exit",
    name: "Exit — Main Gate",
    icon: "🚪",
    position: { x: 0, y: 0, z: -130 },
  },
  {
    id: "exit_04",
    type: "emergency_exit",
    name: "Exit — South",
    icon: "🚪",
    position: { x: 0, y: 0, z: 130 },
  },

  // Alarm Poles
  {
    id: "alarm_01",
    type: "alarm_pole",
    name: "Alarm — Tank Farm",
    icon: "📢",
    position: { x: -100, y: 0, z: 70 },
  },
  {
    id: "alarm_02",
    type: "alarm_pole",
    name: "Alarm — Processing",
    icon: "📢",
    position: { x: 25, y: 0, z: 20 },
  },
  {
    id: "alarm_03",
    type: "alarm_pole",
    name: "Alarm — Boiler",
    icon: "📢",
    position: { x: 80, y: 0, z: 55 },
  },
  {
    id: "alarm_04",
    type: "alarm_pole",
    name: "Alarm — Hazardous",
    icon: "📢",
    position: { x: 45, y: 0, z: -85 },
  },

  // Assembly Point
  {
    id: "assembly_main",
    type: "assembly_point",
    name: "Assembly Point",
    icon: "🟢",
    position: { x: 130, y: 0, z: 100 },
  },
];

// ─── Evacuation Routes ───────────────────────────────────────────────────────
export interface EvacuationRoute {
  id: string;
  name: string;
  fromZone: string;
  exitId: string;
  waypoints: Array<{ x: number; z: number }>;
}

export const EVACUATION_ROUTES: EvacuationRoute[] = [
  {
    id: "route_a",
    name: "Tank Farm → Assembly",
    fromZone: "zone_a",
    exitId: "assembly_main",
    waypoints: [
      { x: -95, z: 85 },
      { x: -50, z: 60 },
      { x: 0, z: 60 },
      { x: 50, z: 60 },
      { x: 100, z: 80 },
      { x: 130, z: 100 },
    ],
  },
  {
    id: "route_b",
    name: "Processing → Main Gate",
    fromZone: "zone_b",
    exitId: "exit_03",
    waypoints: [
      { x: 0, z: 0 },
      { x: 0, z: -40 },
      { x: 0, z: -100 },
      { x: 0, z: -130 },
    ],
  },
  {
    id: "route_c",
    name: "Boiler → Assembly",
    fromZone: "zone_c",
    exitId: "assembly_main",
    waypoints: [
      { x: 60, z: 40 },
      { x: 80, z: 60 },
      { x: 110, z: 80 },
      { x: 130, z: 100 },
    ],
  },
  {
    id: "route_d",
    name: "Hazardous → East Exit",
    fromZone: "zone_d",
    exitId: "exit_02",
    waypoints: [
      { x: 55, z: -70 },
      { x: 80, z: -50 },
      { x: 110, z: -20 },
      { x: 155, z: 0 },
    ],
  },
];

// ─── Vehicle definitions ──────────────────────────────────────────────────────
export type VehicleType = "forklift" | "truck" | "tanker";

export interface VehicleDef {
  id: string;
  type: VehicleType;
  name: string;
  color: number;
  position: { x: number; y: number; z: number };
  route: Array<{ x: number; z: number }>;
  speed: number;
}

export const VEHICLES: VehicleDef[] = [
  {
    id: "v_forklift_01",
    type: "forklift",
    name: "Forklift-01",
    color: 0xeab308,
    position: { x: 65, y: 0, z: -85 },
    route: [
      { x: 65, z: -85 },
      { x: 70, z: -55 },
      { x: 50, z: -55 },
      { x: 65, z: -85 },
    ],
    speed: 0.06,
  },
  {
    id: "v_truck_01",
    type: "truck",
    name: "Truck-01",
    color: 0x64748b,
    position: { x: -30, y: 0, z: -100 },
    route: [
      { x: -30, z: -100 },
      { x: 0, z: -100 },
      { x: 0, z: -40 },
      { x: -110, z: -40 },
      { x: -110, z: -100 },
      { x: -30, z: -100 },
    ],
    speed: 0.04,
  },
  {
    id: "v_tanker_01",
    type: "tanker",
    name: "Chemical Tanker",
    color: 0xef4444,
    position: { x: -110, y: 0, z: 60 },
    route: [
      { x: -110, z: 60 },
      { x: -110, z: -40 },
      { x: 0, z: -40 },
      { x: 0, z: 60 },
      { x: -110, z: 60 },
    ],
    speed: 0.03,
  },
];

// ─── Weather simulation ──────────────────────────────────────────────────────
export interface WeatherData {
  temperature: number;
  humidity: number;
  windSpeed: number;
  windDirection: number; // degrees
  condition: "clear" | "cloudy" | "rain" | "windy";
}

export function simulateWeather(t: number): WeatherData {
  return {
    temperature: 32 + Math.sin(t * 0.01) * 5 + Math.random() * 2,
    humidity: 60 + Math.sin(t * 0.02) * 15 + Math.random() * 5,
    windSpeed: 8 + Math.sin(t * 0.03) * 6 + Math.random() * 3,
    windDirection: (180 + Math.sin(t * 0.005) * 90) % 360,
    condition: Math.random() > 0.7 ? "windy" : Math.random() > 0.5 ? "cloudy" : "clear",
  };
}
