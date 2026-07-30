import {
  LayoutDashboard,
  PlayCircle,
  Map,
  LineChart,
  Workflow,
  FileCheck2,
  MessageSquareText,
  Search,
  Boxes,
  ShieldAlert,
  Scale,
  Radar,
} from "lucide-react";

export type NavItem = {
  title: string;
  to: string;
  icon: typeof LayoutDashboard;
  status?: "live" | "critical" | "warn";
};

// Labels match their destinations. The previous mapping was crossed —
// "Digital Twin" pointed at /simulation and "Plant Heatmap" at /digital-twin.
export const primaryNav: NavItem[] = [
  { title: "Dashboard", to: "/", icon: LayoutDashboard, status: "live" },
  { title: "Digital Twin", to: "/digital-twin", icon: Map },
  { title: "Geospatial & Vision", to: "/geospatial", icon: Radar },
  { title: "Live Replay", to: "/live-replay", icon: PlayCircle },
  { title: "Risk Analytics", to: "/risk-analytics", icon: LineChart },
  { title: "Command Center", to: "/command-center", icon: ShieldAlert, status: "critical" },
  { title: "Agent Workflow", to: "/agent-workflow", icon: Workflow },
  { title: "Permit Intelligence", to: "/permit-intelligence", icon: FileCheck2 },
  { title: "Compliance Assistant", to: "/compliance", icon: MessageSquareText },
];

export const secondaryNav: NavItem[] = [
  { title: "Incident Investigation", to: "/incident-investigation", icon: Search },
  { title: "Evidence Panel", to: "/evidence", icon: Scale },
  { title: "What-If Simulation", to: "/simulation", icon: Boxes },
];
