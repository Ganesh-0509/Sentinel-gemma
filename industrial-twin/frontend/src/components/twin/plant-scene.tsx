import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  SAFETY_ZONES,
  BUILDINGS,
  TANKS,
  PIPE_ROUTES,
  PIPELINE_COLORS,
  type ZoneId,
} from "@/data/factoryData";
import { EMERGENCY_EQUIPMENT, EVACUATION_ROUTES } from "@/data/emergencyData";
import {
  createTextSprite,
  box,
  cyl,
  createWorkerModel,
  createFireExtinguisher,
  createEmergencyExitSign,
  createAlarmPole,
  createFireStation,
  createMedicalRoom,
} from "@/components/scene/sceneHelpers";

// ─── Types ──────────────────────────────────────────────────────────────────

type Status = "safe" | "warning" | "critical" | "neutral";
interface AssetMeta {
  id: string;
  label: string;
  baseColor: number;
  status: Status;
  zone?: ZoneId;
  type?: string;
  description?: string;
}

/** A structure picked out of the 3D plant model. Identity only — no telemetry. */
export interface SelectedAsset {
  id: string;
  name: string;
  type: string;
  zone: string;
  description: string;
}

export interface TwinAlert {
  id: string;
  message: string;
  severity: string;
  time: string;
}

/**
 * A zone as the backend reports it. Coordinates are the API's floor-plan grid
 * (0-100 on both axes); risk is 0-1.
 */
export interface LiveZone {
  zone_id: string;
  name: string;
  x: number;
  y: number;
  risk: number;
  gas_lel: number;
  workers_in_zone: number;
  baseline_alarm: boolean;
}

/** Ground extent the 0-100 floor-plan grid is projected onto. */
const SITE_W = 300;
const SITE_D = 240;
const gridToScene = (x: number, y: number): [number, number] => [
  (x / 100) * SITE_W - SITE_W / 2,
  (y / 100) * SITE_D - SITE_D / 2,
];

/** Physical state of the plant, driven step-by-step by the demo timeline. */
export interface TwinScenario {
  /** 0 = sealed, 1 = full plume. Scales gas particle rate, size, opacity and colour. */
  gasLeak: number;
  /** Welding arc, sparks and work light at the hot-work site. */
  hotWork: boolean;
  /** Flashing red beacons across the site. */
  alarm: boolean;
  /** Evacuation arrows lit and workers converging on the assembly point. */
  evacuation: boolean;
}

/** Ambient state for pages that aren't running the scripted scenario. */
const DEFAULT_SCENARIO: TwinScenario = {
  gasLeak: 0.25,
  hotWork: false,
  alarm: false,
  evacuation: false,
};

/** Overlay layers the operator can switch on and off. */
export interface TwinLayers {
  /** Authored safety-zone ground planes. */
  zones: boolean;
  /** Live per-zone risk columns and labels from the backend. */
  heatmap: boolean;
  /** Crew markers, one per worker the backend reports in each zone. */
  workers: boolean;
  /** Evacuation route arrows. */
  routes: boolean;
}

export interface PlantSceneProps {
  layers: TwinLayers;
  /** Scene backdrop. "dark" matches the control-room shell; "light" is the daylight site render. */
  theme?: "dark" | "light";
  className?: string;
  /** Bumping this number re-frames the camera to its default orbit. */
  resetSignal?: number;
  /**
   * What-if risk (0-100) from the simulation controls. Applied as a plant-wide
   * offset against the zone baselines, so relative zone contrast is preserved.
   * `null`/omitted leaves each zone at its own baseline risk.
   */
  simulatedRisk?: number | null;
  /** Physical scenario state. Omit for ambient behaviour. */
  scenario?: TwinScenario;
  /**
   * Live zones from the backend. When supplied, these replace the authored
   * heatmap: each zone is plotted at its own floor-plan coordinate with its
   * real forecast risk. Pass `null`/omit to fall back to the authored zones.
   */
  liveZones?: LiveZone[] | null;
  onSelectAsset?: (asset: SelectedAsset | null) => void;
}

const BACKDROP = {
  dark: { clear: 0x0f172a, fogNear: 300, fogFar: 620 },
  light: { clear: 0xf5f5f0, fogNear: 250, fogFar: 500 },
} as const;

/** Mean of the authored zone risks — the point a simulated risk is measured against. */
const ZONE_BASELINE_AVG =
  SAFETY_ZONES.reduce((sum, z) => sum + z.riskLevel, 0) / SAFETY_ZONES.length;

// ─── Component ──────────────────────────────────────────────────────────────

export default function PlantScene({
  layers,
  theme = "dark",
  className,
  resetSignal = 0,
  simulatedRisk = null,
  scenario = DEFAULT_SCENARIO,
  liveZones = null,
  onSelectAsset,
}: PlantSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  // Refs for animation access
  const sensorValuesRef = useRef<Map<string, number>>(new Map());
  const timeRef = useRef(0);

  // The scene is built once inside a `[]` effect, so the render loop must read
  // live values through refs rather than the closure captured at mount.
  const layersRef = useRef(layers);
  layersRef.current = layers;

  const themeRef = useRef(theme);
  themeRef.current = theme;

  const simRiskRef = useRef(simulatedRisk);
  simRiskRef.current = simulatedRisk;

  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;

  const liveZonesRef = useRef(liveZones);
  liveZonesRef.current = liveZones;

  const cbRef = useRef({ onSelectAsset });
  cbRef.current = { onSelectAsset };

  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const resetCameraRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    // ── Renderer ────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const backdrop = BACKDROP[themeRef.current];
    renderer.setClearColor(backdrop.clear, 1);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // ── Scene ────────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(backdrop.clear);
    scene.fog = new THREE.Fog(backdrop.clear, backdrop.fogNear, backdrop.fogFar);
    sceneRef.current = scene;

    // ── Camera ──────────────────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 2000);
    const camRadius = 180;
    const camHeight = 150;
    let camAngle = Math.PI / 4;
    let pitchOffset = 0;
    let zoom = 1;

    const updateCamera = () => {
      camera.position.set(
        Math.cos(camAngle) * camRadius * zoom,
        (camHeight + pitchOffset) * zoom,
        Math.sin(camAngle) * camRadius * zoom,
      );
      camera.lookAt(0, 0, 0);
    };
    updateCamera();

    resetCameraRef.current = () => {
      camAngle = Math.PI / 4;
      pitchOffset = 0;
      zoom = 1;
      updateCamera();
    };

    // ── Lighting ─────────────────────────────────────────────────────────
    scene.add(new THREE.HemisphereLight(0xffffff, 0xdedede, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(120, 200, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -200;
    sun.shadow.camera.right = 200;
    sun.shadow.camera.top = 200;
    sun.shadow.camera.bottom = -200;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 500;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
    fill.position.set(-100, 80, -60);
    scene.add(fill);

    // ── Root & registry ─────────────────────────────────────────────────
    const root = new THREE.Group();
    scene.add(root);
    const assets: THREE.Object3D[] = [];
    const registerAsset = (obj: THREE.Object3D, meta: AssetMeta) => {
      obj.userData = { ...meta };
      obj.traverse((c) => {
        c.castShadow = true;
        c.receiveShadow = true;
      });
      assets.push(obj);
      root.add(obj);
      return obj;
    };

    // ── Materials ────────────────────────────────────────────────────────
    const mat = {
      ground: new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.95 }),
      road: new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.9 }),
      pathway: new THREE.MeshStandardMaterial({ color: 0xb8b3a4, roughness: 0.95 }),
      grass: new THREE.MeshStandardMaterial({ color: 0x6aa84f, roughness: 1 }),
      steel: new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.45, metalness: 0.65 }),
      steelDark: new THREE.MeshStandardMaterial({
        color: 0x6f7480,
        roughness: 0.55,
        metalness: 0.6,
      }),
      tank: new THREE.MeshStandardMaterial({ color: 0xd8dce0, roughness: 0.4, metalness: 0.55 }),
      tankTop: new THREE.MeshStandardMaterial({ color: 0xb8bec5, roughness: 0.5, metalness: 0.5 }),
      building: new THREE.MeshStandardMaterial({ color: 0xf1f0eb, roughness: 0.85 }),
      roofBlue: new THREE.MeshStandardMaterial({ color: 0x27548a, roughness: 0.7 }),
      roofGrey: new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.8 }),
      chimney: new THREE.MeshStandardMaterial({ color: 0xe0dcd4, roughness: 0.8 }),
      chimneyBand: new THREE.MeshStandardMaterial({ color: 0xc44536, roughness: 0.8 }),
      pipe: new THREE.MeshStandardMaterial({ color: 0xa9adb5, roughness: 0.5, metalness: 0.7 }),
      pipeYellow: new THREE.MeshStandardMaterial({
        color: 0xd9a02b,
        roughness: 0.55,
        metalness: 0.5,
      }),
      wall: new THREE.MeshStandardMaterial({ color: 0xd8d3c4, roughness: 0.9 }),
      glass: new THREE.MeshStandardMaterial({
        color: 0x86a7c6,
        roughness: 0.25,
        metalness: 0.3,
        transparent: true,
        opacity: 0.85,
      }),
      hydrant: new THREE.MeshStandardMaterial({ color: 0xd93a2b, roughness: 0.6 }),
      sign: new THREE.MeshStandardMaterial({ color: 0x2fa84f, roughness: 0.8 }),
      light: new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, metalness: 0.7 }),
      trunk: new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 }),
      leaves: new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 1 }),
      assembly: new THREE.MeshStandardMaterial({ color: 0x2fa84f, roughness: 0.95 }),
      fencePost: new THREE.MeshStandardMaterial({
        color: 0x6b7280,
        roughness: 0.6,
        metalness: 0.4,
      }),
      fenceWire: new THREE.MeshStandardMaterial({
        color: 0x9ca3af,
        roughness: 0.5,
        metalness: 0.6,
        transparent: true,
        opacity: 0.7,
      }),
    };

    // ══════════════════════════════════════════════════════════════════════
    //  BUILD THE SCENE — same layout as before + intelligence layer
    // ══════════════════════════════════════════════════════════════════════

    // ── Ground ──────────────────────────────────────────────────────────
    const base = new THREE.Mesh(new THREE.BoxGeometry(320, 4, 260), mat.ground);
    base.position.y = -2;
    base.receiveShadow = true;
    scene.add(base);

    // ── Safety Zone overlays (colored ground planes) ────────────────────
    const zoneOverlays = new THREE.Group();
    SAFETY_ZONES.forEach((zone) => {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(zone.bounds.w, zone.bounds.d),
        new THREE.MeshBasicMaterial({
          color: zone.color,
          transparent: true,
          opacity: 0.12,
          side: THREE.DoubleSide,
        }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(zone.bounds.x, 0.15, zone.bounds.z);

      // Zone border
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-zone.bounds.w / 2, 0, -zone.bounds.d / 2),
          new THREE.Vector3(zone.bounds.w / 2, 0, -zone.bounds.d / 2),
          new THREE.Vector3(zone.bounds.w / 2, 0, zone.bounds.d / 2),
          new THREE.Vector3(-zone.bounds.w / 2, 0, zone.bounds.d / 2),
        ]),
        new THREE.LineBasicMaterial({ color: zone.color, transparent: true, opacity: 0.4 }),
      );
      border.position.set(zone.bounds.x, 0.2, zone.bounds.z);

      // Zone label
      const label = createTextSprite(zone.label, {
        fontSize: 24,
        bgColor: "#ffffff",
        bgOpacity: 0.9,
        color: "#1e293b",
      });
      label.position.set(zone.bounds.x, 2, zone.bounds.z - zone.bounds.d / 2 + 5);

      zoneOverlays.add(plane, border, label);
    });
    zoneOverlays.userData = { id: "zone_overlays" };
    root.add(zoneOverlays);

    // ── Boundary walls ──────────────────────────────────────────────────
    const wallH = 3,
      wallT = 1;
    const boundary = new THREE.Group();
    const addWall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), mat.wall);
      m.position.set(x, wallH / 2, z);
      boundary.add(m);
    };
    addWall(320, wallT, 0, -130);
    addWall(320, wallT, 0, 130);
    addWall(wallT, 260, -160, 0);
    addWall(wallT, 260, 160, 0);

    // Fence posts
    for (let x = -155; x <= 155; x += 10) {
      const post = cyl(0.2, 0.2, 4, mat.fencePost, x, 2, -130);
      boundary.add(post);
      const post2 = post.clone();
      post2.position.z = 130;
      boundary.add(post2);
    }
    for (let z = -125; z <= 125; z += 10) {
      const post = cyl(0.2, 0.2, 4, mat.fencePost, -160, 2, z);
      boundary.add(post);
      const post2 = post.clone();
      post2.position.x = 160;
      boundary.add(post2);
    }

    registerAsset(boundary, {
      id: "boundary_wall",
      label: "Boundary Fence",
      baseColor: 0x3a3f48,
      status: "neutral",
    });

    // ── Main Gate ────────────────────────────────────────────────────────
    const gate = new THREE.Group();
    const gatePillarL = new THREE.Mesh(new THREE.BoxGeometry(3, 8, 3), mat.steelDark);
    gatePillarL.position.set(-10, 4, -130);
    const gatePillarR = gatePillarL.clone();
    gatePillarR.position.x = 10;
    const gateBeam = new THREE.Mesh(new THREE.BoxGeometry(23, 1.5, 1.5), mat.steelDark);
    gateBeam.position.set(0, 8.5, -130);
    const gateSign = new THREE.Mesh(new THREE.BoxGeometry(14, 2.5, 0.3), mat.roofBlue);
    gateSign.position.set(0, 10.5, -130);
    gate.add(gatePillarL, gatePillarR, gateBeam, gateSign);
    const gateLabel = createTextSprite("⚙ INDUSTRIAL DIGITAL TWIN", {
      fontSize: 22,
      bgColor: "#1e3a5f",
    });
    gateLabel.position.set(0, 12.5, -130);
    gate.add(gateLabel);
    registerAsset(gate, {
      id: "main_gate",
      label: "Main Gate",
      baseColor: 0x3a4050,
      status: "safe",
    });

    // ── Security booth ──────────────────────────────────────────────────
    const booth = new THREE.Group();
    booth.add(box(6, 5, 5, mat.building, 0, 2.5, 0));
    booth.add(box(7, 0.6, 6, mat.roofBlue, 0, 5.3, 0));
    booth.add(box(4, 2, 0.2, mat.glass, 0, 3, 2.6));
    booth.position.set(-22, 0, -122);
    const boothLabel = createTextSprite("Security Booth", { fontSize: 20, bgColor: "#1e3a5f" });
    boothLabel.position.y = 8;
    booth.add(boothLabel);
    registerAsset(booth, {
      id: "security_booth",
      label: "Security Booth",
      baseColor: 0x3a4050,
      status: "safe",
      zone: "zone_b",
    });

    // ── Roads ────────────────────────────────────────────────────────────
    const roads = new THREE.Group();
    const roadY = 0.05;
    const addRoad = (w: number, d: number, x: number, z: number) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), mat.road);
      r.position.set(x, roadY, z);
      roads.add(r);
    };
    addRoad(20, 260, 0, 0);
    addRoad(300, 16, 0, 60);
    addRoad(300, 16, 0, -40);
    addRoad(300, 14, 0, -100);
    addRoad(14, 260, -110, 0);
    addRoad(14, 260, 110, 0);
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x8a7020, roughness: 0.9 });
    for (let z = -120; z <= 120; z += 12) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.11, 4), stripeMat);
      s.position.set(0, 0.11, z);
      roads.add(s);
    }
    registerAsset(roads, {
      id: "roads",
      label: "Internal Roads",
      baseColor: 0x252a35,
      status: "neutral",
    });

    // ── Pathways ─────────────────────────────────────────────────────────
    const pathways = new THREE.Group();
    const addPath = (w: number, d: number, x: number, z: number) => {
      const p = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), mat.pathway);
      p.position.set(x, 0.06, z);
      pathways.add(p);
    };
    addPath(60, 2, -50, 90);
    addPath(60, 2, 50, 90);
    addPath(2, 40, -80, 20);
    addPath(2, 40, 80, 20);
    registerAsset(pathways, {
      id: "pathways",
      label: "Worker Pathways",
      baseColor: 0x2a2f3a,
      status: "neutral",
    });

    // ── Green zones ─────────────────────────────────────────────────────
    const greens = new THREE.Group();
    (
      [
        [-130, 100],
        [130, 100],
        [-130, -80],
        [130, -80],
      ] as const
    ).forEach(([x, z]) => {
      const g = new THREE.Mesh(new THREE.BoxGeometry(40, 0.15, 30), mat.grass);
      g.position.set(x, 0.08, z);
      greens.add(g);
    });
    registerAsset(greens, {
      id: "green_zones",
      label: "Green Safety Zones",
      baseColor: 0x1a4a28,
      status: "safe",
    });

    // ── Assembly Point ──────────────────────────────────────────────────
    const assemblyGroup = new THREE.Group();
    const assemblyPad = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 0.2, 32), mat.assembly);
    assemblyPad.position.y = 0.1;
    const assemblyRing = new THREE.Mesh(
      new THREE.RingGeometry(9, 10, 32),
      new THREE.MeshBasicMaterial({
        color: 0x22c55e,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.5,
      }),
    );
    assemblyRing.rotation.x = -Math.PI / 2;
    assemblyRing.position.y = 0.22;
    assemblyGroup.add(assemblyPad, assemblyRing);
    assemblyGroup.position.set(130, 0, 100);
    const assemblyLabel = createTextSprite("🟢 Assembly Point", {
      fontSize: 24,
      bgColor: "#14532d",
    });
    assemblyLabel.position.y = 3;
    assemblyGroup.add(assemblyLabel);
    registerAsset(assemblyGroup, {
      id: "assembly_point",
      label: "Emergency Assembly Point",
      baseColor: 0x16a34a,
      status: "safe",
    });

    // ══════════════════════════════════════════════════════════════════════
    //  STORAGE TANKS (with labels)
    // ══════════════════════════════════════════════════════════════════════

    const makeTank = (radius: number, height: number, color: number) => {
      const g = new THREE.Group();
      const body = cyl(
        radius,
        radius,
        height,
        new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.55 }),
        0,
        height / 2,
        0,
      );
      const top = cyl(radius, radius * 0.98, 0.6, mat.tankTop, 0, height + 0.3, 0);
      const ring1 = new THREE.Mesh(
        new THREE.TorusGeometry(radius + 0.3, 0.15, 8, 32),
        mat.steelDark,
      );
      ring1.rotation.x = Math.PI / 2;
      ring1.position.y = height * 0.5;
      const ring2 = ring1.clone();
      ring2.position.y = height * 0.85;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const bar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.15, 0.15, height, 6),
          mat.steelDark,
        );
        bar.position.set(Math.cos(a) * (radius + 0.3), height / 2, Math.sin(a) * (radius + 0.3));
        g.add(bar);
      }
      g.add(body, top, ring1, ring2);
      return g;
    };

    // Create tanks with labels from data
    TANKS.forEach((tankInfo) => {
      const radius = tankInfo.id === "tank_d" ? 7 : tankInfo.id === "tank_e" ? 6 : 11;
      const height = tankInfo.id === "tank_d" ? 10 : tankInfo.id === "tank_e" ? 9 : 16;

      const riskColor =
        tankInfo.riskLevel > 70 ? 0x7f1d1d : tankInfo.riskLevel > 40 ? 0x5a4a20 : 0x1a3a28;
      const tankColor =
        tankInfo.riskLevel > 70 ? 0xb08080 : tankInfo.riskLevel > 40 ? 0xa0a088 : 0x7a8a90;

      const tankMesh = makeTank(radius, height, tankColor);
      tankMesh.position.set(tankInfo.position.x, 0, tankInfo.position.z);

      // Tank name + contents label
      const label = createTextSprite(`${tankInfo.name} — ${tankInfo.contents}`, {
        fontSize: 22,
        bgColor: riskColor > 0x500000 ? "#7f1d1d" : "#1e3a5f",
      });
      label.position.y = height + 3;
      tankMesh.add(label);

      // Fill level indicator (thin ring)
      const fillHeight = height * (tankInfo.fillLevel / 100);
      const fillIndicator = new THREE.Mesh(
        new THREE.CylinderGeometry(radius + 0.5, radius + 0.5, 0.3, 32, 1, true),
        new THREE.MeshBasicMaterial({
          color: tankInfo.fillLevel > 80 ? 0xef4444 : tankInfo.fillLevel > 50 ? 0xeab308 : 0x22c55e,
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
        }),
      );
      fillIndicator.position.y = fillHeight;
      tankMesh.add(fillIndicator);

      const status: Status =
        tankInfo.riskLevel > 70 ? "critical" : tankInfo.riskLevel > 40 ? "warning" : "safe";
      registerAsset(tankMesh, {
        id: tankInfo.id,
        label: `${tankInfo.name} (${tankInfo.contents})`,
        baseColor: tankColor,
        status,
        zone: "zone_a",
        type: "Tank",
        description: `${tankInfo.contents} tank — ${tankInfo.capacity}, ${tankInfo.fillLevel}% full`,
      });
    });

    // ══════════════════════════════════════════════════════════════════════
    //  PRESSURE VESSELS
    // ══════════════════════════════════════════════════════════════════════

    const pressureVessels = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const v = new THREE.Group();
      const body = cyl(3, 3, 14, mat.tank);
      body.rotation.z = Math.PI / 2;
      body.position.y = 4;
      const capL = new THREE.Mesh(new THREE.SphereGeometry(3, 20, 16, 0, Math.PI), mat.tank);
      capL.rotation.z = Math.PI / 2;
      capL.position.set(-7, 4, 0);
      const capR = capL.clone();
      capR.rotation.z = -Math.PI / 2;
      capR.position.x = 7;
      const legL = box(0.6, 4, 3, mat.steelDark, -4, 2, 0);
      const legR = box(0.6, 4, 3, mat.steelDark, 4, 2, 0);
      v.add(body, capL, capR, legL, legR);
      v.position.set(60 + i * 12, 0, -70);
      pressureVessels.add(v);
    }
    const pvLabel = createTextSprite("Pressure Vessels", { fontSize: 20, bgColor: "#7f1d1d" });
    pvLabel.position.set(72, 10, -70);
    pressureVessels.add(pvLabel);
    registerAsset(pressureVessels, {
      id: "pressure_vessels",
      label: "Pressure Vessels",
      baseColor: 0x707a88,
      status: "warning",
      zone: "zone_d",
      type: "PressureVessel",
    });

    // ── Heat Exchangers ─────────────────────────────────────────────────
    const heatExchangers = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const h = new THREE.Group();
      const body = cyl(1.8, 1.8, 9, mat.pipe);
      body.rotation.z = Math.PI / 2;
      body.position.y = 3;
      const flangeL = cyl(2.1, 2.1, 0.6, mat.steelDark);
      flangeL.rotation.z = Math.PI / 2;
      flangeL.position.set(-4.5, 3, 0);
      const flangeR = flangeL.clone();
      flangeR.position.x = 4.5;
      const legL = box(0.4, 3, 2, mat.steelDark, -2.5, 1.5, 0);
      const legR = box(0.4, 3, 2, mat.steelDark, 2.5, 1.5, 0);
      h.add(body, flangeL, flangeR, legL, legR);
      h.position.set(30 + i * 8, 0, -70);
      heatExchangers.add(h);
    }
    registerAsset(heatExchangers, {
      id: "heat_exchangers",
      label: "Heat Exchangers",
      baseColor: 0x5a6474,
      status: "safe",
      zone: "zone_d",
    });

    // ══════════════════════════════════════════════════════════════════════
    //  REFINERY PROCESSING UNIT
    // ══════════════════════════════════════════════════════════════════════

    const refinery = new THREE.Group();
    const plat = box(46, 1, 36, mat.steelDark, 0, 0.5, 0);
    refinery.add(plat);
    for (let x = -20; x <= 20; x += 10) {
      for (let z = -14; z <= 14; z += 14) {
        refinery.add(box(0.8, 22, 0.8, mat.steelDark, x, 11, z));
      }
    }
    for (let y = 6; y <= 22; y += 8) {
      const bx = box(46, 0.5, 0.5, mat.steelDark, 0, y, -14);
      const bx2 = bx.clone();
      bx2.position.z = 14;
      const bz = box(0.5, 0.5, 30, mat.steelDark, -20, y, 0);
      const bz2 = bz.clone();
      bz2.position.x = 20;
      refinery.add(bx, bx2, bz, bz2);
    }
    const towerColors = [0x505868, 0x4a5260, 0x586070, 0x4e5668, 0x444c58];
    const towerSpecs: Array<[number, number, number, number]> = [
      [-15, 0, 3, 22],
      [-5, 0, 2.5, 26],
      [5, 0, 3, 18],
      [14, 0, 2.2, 24],
      [-10, 10, 2, 16],
    ];
    towerSpecs.forEach(([x, z, r, h], i) => {
      const t = cyl(
        r,
        r,
        h,
        new THREE.MeshStandardMaterial({ color: towerColors[i], roughness: 0.45, metalness: 0.55 }),
        x,
        1 + h / 2,
        z,
      );
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        mat.tankTop,
      );
      cap.position.set(x, 1 + h, z);
      refinery.add(t, cap);
    });
    refinery.position.set(0, 0, 0);
    const refineryLabel = createTextSprite("Refinery Processing Unit", {
      fontSize: 22,
      bgColor: "#1e3a5f",
    });
    refineryLabel.position.y = 30;
    refinery.add(refineryLabel);
    registerAsset(refinery, {
      id: "refinery_unit",
      label: "Refinery Processing Unit",
      baseColor: 0x4a5260,
      status: "warning",
      zone: "zone_b",
      type: "Refinery",
    });

    // ── Distillation Towers ─────────────────────────────────────────────
    const distillation = new THREE.Group();
    const towerHeights = [34, 40, 30];
    towerHeights.forEach((h, i) => {
      const t = new THREE.Group();
      const body = cyl(2.5, 2.5, h, mat.tank, 0, h / 2, 0);
      const top = new THREE.Mesh(
        new THREE.SphereGeometry(2.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        mat.tankTop,
      );
      top.position.y = h;
      for (let py = 8; py < h; py += 8) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(3, 0.15, 8, 20), mat.steelDark);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = py;
        t.add(ring);
      }
      t.add(body, top);
      t.position.set(-18 + i * 10, 0, -75);
      distillation.add(t);
    });
    registerAsset(distillation, {
      id: "distillation_towers",
      label: "Distillation Towers",
      baseColor: 0x707a88,
      status: "safe",
      zone: "zone_d",
    });

    // ══════════════════════════════════════════════════════════════════════
    //  BOILER HOUSE
    // ══════════════════════════════════════════════════════════════════════

    const boilerHouse = new THREE.Group();
    const boilerBody = box(28, 14, 20, mat.building, 0, 7, 0);
    const boilerRoof = box(29, 1, 21, mat.roofBlue, 0, 14.5, 0);
    for (let x = -10; x <= 10; x += 4) {
      boilerHouse.add(box(1.5, 8, 0.2, mat.steelDark, x, 8, 10.1));
    }
    const stackA = cyl(1.2, 1.2, 12, mat.chimney, -6, 20, 0);
    const stackB = cyl(1.2, 1.2, 12, mat.chimney, 6, 20, 0);
    boilerHouse.add(boilerBody, boilerRoof, stackA, stackB);
    boilerHouse.position.set(60, 0, 40);
    const boilerLabel = createTextSprite("🔥 Boiler House", { fontSize: 22, bgColor: "#7f1d1d" });
    boilerLabel.position.y = 18;
    boilerHouse.add(boilerLabel);
    registerAsset(boilerHouse, {
      id: "boiler_house",
      label: "Boiler House",
      baseColor: 0x3a4050,
      status: "warning",
      zone: "zone_c",
      type: "Boiler",
      description: "Main steam generation. 2 high-pressure boilers.",
    });

    // ── Cooling Towers ──────────────────────────────────────────────────
    const makeCoolingTower = () => {
      const g = new THREE.Group();
      const points: THREE.Vector2[] = [];
      const h = 26;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const y = t * h;
        const r = 9 - 4 * Math.sin(t * Math.PI);
        points.push(new THREE.Vector2(r, y));
      }
      const geo = new THREE.LatheGeometry(points, 40);
      const body = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: 0x4a5058,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      );
      const rimTop = cyl(6, 6, 0.4, mat.steelDark, 0, h + 0.2, 0);
      g.add(body, rimTop);
      return g;
    };
    const coolingTower = makeCoolingTower();
    coolingTower.position.set(90, 0, 90);
    const ctLabel = createTextSprite("Cooling Tower A", { fontSize: 22, bgColor: "#7f1d1d" });
    ctLabel.position.y = 30;
    coolingTower.add(ctLabel);
    registerAsset(coolingTower, {
      id: "cooling_tower",
      label: "Cooling Tower A",
      baseColor: 0x4a5058,
      status: "critical",
      zone: "zone_c",
      type: "CoolingPlant",
    });

    const coolingTower2 = makeCoolingTower();
    coolingTower2.scale.set(0.75, 0.75, 0.75);
    coolingTower2.position.set(115, 0, 60);
    const ct2Label = createTextSprite("Cooling Tower B", { fontSize: 20, bgColor: "#1e3a5f" });
    ct2Label.position.y = 24;
    coolingTower2.add(ct2Label);
    registerAsset(coolingTower2, {
      id: "cooling_tower_2",
      label: "Cooling Tower B",
      baseColor: 0x4a5058,
      status: "safe",
      zone: "zone_c",
    });

    // ── Chimneys ────────────────────────────────────────────────────────
    const chimneys = new THREE.Group();
    const chimneyPositions: Array<[number, number, number]> = [
      [40, 0, 90],
      [50, 0, 105],
      [-40, 0, -100],
    ];
    chimneyPositions.forEach(([x, , z]) => {
      const c = new THREE.Group();
      const shaft = cyl(1.8, 2.3, 42, mat.chimney, 0, 21, 0);
      const band1 = cyl(1.9, 1.9, 1.2, mat.chimneyBand, 0, 12, 0);
      const band2 = cyl(1.85, 1.85, 1.2, mat.chimneyBand, 0, 30, 0);
      const cap = cyl(2, 2, 0.6, mat.steelDark, 0, 42.4, 0);
      c.add(shaft, band1, band2, cap);
      c.position.set(x, 0, z);
      chimneys.add(c);
    });
    registerAsset(chimneys, {
      id: "chimneys",
      label: "Industrial Chimneys",
      baseColor: 0x606a74,
      status: "safe",
    });

    // ── Control Room ────────────────────────────────────────────────────
    const controlRoom = new THREE.Group();
    const crBody = box(30, 10, 18, mat.building, 0, 5, 0);
    const crRoof = box(31, 0.6, 19, mat.roofGrey, 0, 10.3, 0);
    const crWin = box(28, 3, 0.3, mat.glass, 0, 6, 9.1);
    const crWinB = crWin.clone();
    crWinB.position.z = -9.1;
    const crDoor = box(3, 5, 0.4, mat.roofBlue, 0, 2.5, 9.2);
    const ant = cyl(0.15, 0.15, 6, mat.steelDark, 12, 13.5, 0);
    // Satellite dish
    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 16, 8, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x6b7280, metalness: 0.5 }),
    );
    dish.rotation.x = -Math.PI / 4;
    dish.position.set(-10, 11, 0);
    controlRoom.add(crBody, crRoof, crWin, crWinB, crDoor, ant, dish);
    controlRoom.position.set(-80, 0, -80);
    const crLabel = createTextSprite("🧠 Control Room — AI Brain", {
      fontSize: 22,
      bgColor: "#1e3a5f",
    });
    crLabel.position.y = 14;
    controlRoom.add(crLabel);
    registerAsset(controlRoom, {
      id: "control_room",
      label: "Control Room",
      baseColor: 0x3a4050,
      status: "safe",
      zone: "zone_b",
      type: "ControlRoom",
      description: "Central AI brain — monitors all sensors, cameras, and predictions.",
    });

    // ── Maintenance Workshop ────────────────────────────────────────────
    const maintenance = new THREE.Group();
    const mBody = box(34, 12, 22, mat.building, 0, 6, 0);
    const mRoof = new THREE.Mesh(
      new THREE.CylinderGeometry(11.5, 11.5, 34, 3, 1, false, 0, Math.PI),
      mat.roofBlue,
    );
    mRoof.rotation.z = Math.PI / 2;
    mRoof.position.y = 12;
    for (let x = -12; x <= 12; x += 12) {
      maintenance.add(box(8, 8, 0.3, mat.steelDark, x, 4, 11.1));
    }
    maintenance.add(mBody, mRoof);
    maintenance.position.set(-70, 0, -30);
    const maintLabel = createTextSprite("🔧 Maintenance Workshop", {
      fontSize: 22,
      bgColor: "#1e3a5f",
    });
    maintLabel.position.y = 16;
    maintenance.add(maintLabel);
    registerAsset(maintenance, {
      id: "maintenance_workshop",
      label: "Maintenance Workshop",
      baseColor: 0x3a4050,
      status: "safe",
      zone: "zone_b",
    });

    // ── Warehouse ────────────────────────────────────────────────────────
    const warehouse = new THREE.Group();
    const wBody = box(46, 12, 26, mat.building, 0, 6, 0);
    const wRoof = box(47, 0.8, 27, mat.roofGrey, 0, 12.4, 0);
    for (let x = -18; x <= 18; x += 9) {
      warehouse.add(box(6, 0.3, 22, mat.glass, x, 12.7, 0));
    }
    for (let x = -18; x <= 18; x += 12) {
      warehouse.add(box(9, 9, 0.3, mat.steelDark, x, 4.5, 13.1));
    }
    warehouse.add(wBody, wRoof);
    warehouse.position.set(70, 0, -80);
    const whLabel = createTextSprite("📦 Warehouse", { fontSize: 22, bgColor: "#1e3a5f" });
    whLabel.position.y = 16;
    warehouse.add(whLabel);
    registerAsset(warehouse, {
      id: "warehouse",
      label: "Warehouse",
      baseColor: 0x3a4050,
      status: "safe",
      zone: "zone_b",
    });

    // ── Loading Dock ────────────────────────────────────────────────────
    const loadingDock = new THREE.Group();
    const ldPad = box(30, 1.2, 12, mat.steelDark, 0, 0.6, 0);
    for (let x = -12; x <= 12; x += 6) {
      loadingDock.add(box(2, 0.8, 1, mat.chimneyBand, x, 1.4, 6));
    }
    const canopy = box(30, 0.4, 8, mat.roofBlue, 0, 6, -1);
    loadingDock.add(
      ldPad,
      canopy,
      box(0.5, 5.5, 0.5, mat.steelDark, -14, 3, -3),
      box(0.5, 5.5, 0.5, mat.steelDark, 14, 3, -3),
    );
    loadingDock.position.set(70, 0, -55);
    registerAsset(loadingDock, {
      id: "loading_dock",
      label: "Loading Dock",
      baseColor: 0x3a4050,
      status: "safe",
      zone: "zone_b",
    });

    // ── Pump House ──────────────────────────────────────────────────────
    const pumpHouse = new THREE.Group();
    const phBody = box(14, 7, 10, mat.building, 0, 3.5, 0);
    const phRoof = box(15, 0.5, 11, mat.roofBlue, 0, 7.3, 0);
    for (let x = -4; x <= 4; x += 4) {
      pumpHouse.add(cyl(0.8, 1, 2, mat.pipeYellow, x, 8, 0));
    }
    pumpHouse.add(phBody, phRoof);
    pumpHouse.position.set(-45, 0, 40);
    const phLabel = createTextSprite("⚙ Pump House", { fontSize: 20, bgColor: "#1e3a5f" });
    phLabel.position.y = 10;
    pumpHouse.add(phLabel);
    registerAsset(pumpHouse, {
      id: "pump_house",
      label: "Pump House",
      baseColor: 0x3a4050,
      status: "safe",
      zone: "zone_b",
    });

    // ── Parking ─────────────────────────────────────────────────────────
    const parking = new THREE.Group();
    const parkPad = box(
      50,
      0.15,
      24,
      new THREE.MeshStandardMaterial({ color: 0x252a35, roughness: 0.95 }),
      0,
      0.1,
      0,
    );
    const stripeM = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9 });
    for (let x = -22; x <= 22; x += 4) {
      parking.add(box(0.3, 0.05, 10, stripeM, x, 0.2, 0));
    }
    parking.add(parkPad);
    parking.position.set(-40, 0, -110);
    registerAsset(parking, {
      id: "parking_area",
      label: "Parking Area",
      baseColor: 0x252a35,
      status: "neutral",
    });

    // ══════════════════════════════════════════════════════════════════════
    //  COLOR-CODED PIPE NETWORK
    // ══════════════════════════════════════════════════════════════════════

    const pipeNetwork = new THREE.Group();
    const pipeFlowParticles: THREE.Mesh[] = [];

    PIPE_ROUTES.forEach((route) => {
      const config = PIPELINE_COLORS[route.type];
      const from = new THREE.Vector3(route.from.x, route.from.y, route.from.z);
      const to = new THREE.Vector3(route.to.x, route.to.y, route.to.z);
      const dir = to.clone().sub(from);
      const len = dir.length();
      const mid = from.clone().add(dir.clone().multiplyScalar(0.5));
      const angleY = Math.atan2(dir.x, dir.z);
      const rackMat = mat.steelDark;

      // Deck
      const deck = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.4, len), rackMat);
      deck.position.copy(mid);
      deck.position.y = 5.2;
      deck.rotation.y = angleY;
      pipeNetwork.add(deck);

      // 3 pipes with the route color
      const pipeMat = new THREE.MeshStandardMaterial({
        color: config.color,
        emissive: config.emissive,
        emissiveIntensity: 0.2,
        roughness: 0.4,
        metalness: 0.6,
      });

      for (let i = -1; i <= 1; i++) {
        const wrap = new THREE.Group();
        wrap.position.copy(mid);
        wrap.position.y = 5.9;
        wrap.rotation.y = angleY;
        const pipeM = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, len, 12), pipeMat);
        pipeM.rotation.x = Math.PI / 2;
        pipeM.position.set(i * 0.9, 0, 0);
        wrap.add(pipeM);
        pipeNetwork.add(wrap);
      }

      // Support legs
      const steps = Math.max(2, Math.floor(len / 10));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = from.x + dir.x * t;
        const pz = from.z + dir.z * t;
        const perp = new THREE.Vector3(Math.cos(angleY), 0, -Math.sin(angleY));
        const legL = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5, 0.4), rackMat);
        legL.position.set(px + perp.x * 1.5, 2.5, pz + perp.z * 1.5);
        const legR = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5, 0.4), rackMat);
        legR.position.set(px - perp.x * 1.5, 2.5, pz - perp.z * 1.5);
        pipeNetwork.add(legL, legR);
      }

      // Flow particles (small glowing spheres that move along the pipe)
      const particleCount = Math.max(3, Math.floor(len / 12));
      for (let p = 0; p < particleCount; p++) {
        const particle = new THREE.Mesh(
          new THREE.SphereGeometry(0.3, 8, 8),
          new THREE.MeshBasicMaterial({ color: config.color, transparent: true, opacity: 0.8 }),
        );
        particle.userData = {
          from,
          to,
          offset: p / particleCount,
          speed: 0.0004 + Math.random() * 0.0002,
        };
        particle.position.y = 5.9;
        pipeNetwork.add(particle);
        pipeFlowParticles.push(particle);
      }

      // Pipe type label at midpoint
      const pipeLabel = createTextSprite(config.label, {
        fontSize: 16,
        bgColor: "#1f2937",
        bgOpacity: 0.7,
      });
      pipeLabel.position.set(mid.x, 8, mid.z);
      pipeNetwork.add(pipeLabel);
    });

    registerAsset(pipeNetwork, {
      id: "pipe_network",
      label: "Pipe Network",
      baseColor: 0x5a6474,
      status: "safe",
    });

    // ── Conveyor System ─────────────────────────────────────────────────
    const conveyors = new THREE.Group();
    const makeConveyor = (len: number, x: number, z: number, rotY: number) => {
      const g = new THREE.Group();
      const belt = new THREE.Mesh(
        new THREE.BoxGeometry(2, 0.4, len),
        new THREE.MeshStandardMaterial({ color: 0x1c1f26, roughness: 0.7 }),
      );
      belt.position.y = 3;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, len), mat.steelDark);
      frame.position.y = 2.6;
      g.add(belt, frame);
      const nLegs = Math.floor(len / 4);
      for (let i = 0; i <= nLegs; i++) {
        const t = i / nLegs;
        const zl = -len / 2 + t * len;
        g.add(
          new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.4, 0.3), mat.steelDark)
            .translateX(-1)
            .translateY(1.2)
            .translateZ(zl),
        );
        g.add(
          new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.4, 0.3), mat.steelDark)
            .translateX(1)
            .translateY(1.2)
            .translateZ(zl),
        );
      }
      g.position.set(x, 0, z);
      g.rotation.y = rotY;
      return g;
    };
    conveyors.add(makeConveyor(22, 70, -95, 0));
    conveyors.add(makeConveyor(18, 55, -80, Math.PI / 2));
    registerAsset(conveyors, {
      id: "conveyors",
      label: "Conveyor System",
      baseColor: 0x1c1f26,
      status: "safe",
      zone: "zone_b",
    });

    // ── Fire Hydrants ───────────────────────────────────────────────────
    const hydrants = new THREE.Group();
    const hydrantSpots: Array<[number, number]> = [
      [-95, 60],
      [-40, 60],
      [40, 60],
      [95, 60],
      [-95, -20],
      [40, -20],
      [95, -20],
      [-40, 105],
      [40, 105],
    ];
    hydrantSpots.forEach(([x, z]) => {
      const h = new THREE.Group();
      h.add(cyl(0.5, 0.6, 1.6, mat.hydrant, 0, 0.8, 0));
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), mat.hydrant);
      top.position.y = 1.7;
      const arm1 = cyl(0.2, 0.2, 1.2, mat.hydrant, 0, 1.2, 0);
      arm1.rotation.z = Math.PI / 2;
      h.add(top, arm1);
      h.position.set(x, 0, z);
      hydrants.add(h);
    });
    registerAsset(hydrants, {
      id: "fire_hydrants",
      label: "Fire Hydrants",
      baseColor: 0xd93a2b,
      status: "safe",
    });

    // ── Safety Signs ────────────────────────────────────────────────────
    const signs = new THREE.Group();
    (
      [
        [-60, 50],
        [60, 50],
        [-60, -60],
        [60, -60],
        [0, 100],
        [0, -110],
      ] as const
    ).forEach(([x, z]) => {
      const s = new THREE.Group();
      s.add(cyl(0.15, 0.15, 3, mat.steelDark, 0, 1.5, 0));
      s.add(box(2.2, 1.6, 0.15, mat.sign, 0, 3.5, 0));
      s.position.set(x, 0, z);
      signs.add(s);
    });
    registerAsset(signs, {
      id: "safety_signs",
      label: "Safety Signboards",
      baseColor: 0x16a34a,
      status: "safe",
    });

    // ── Lighting Poles ──────────────────────────────────────────────────
    const lights = new THREE.Group();
    const lightSpots: Array<[number, number]> = [];
    for (let x = -140; x <= 140; x += 40) {
      lightSpots.push([x, -115], [x, 115]);
    }
    for (let z = -100; z <= 100; z += 40) {
      lightSpots.push([-145, z], [145, z]);
    }
    lightSpots.forEach(([x, z]) => {
      const l = new THREE.Group();
      l.add(cyl(0.2, 0.3, 12, mat.light, 0, 6, 0));
      l.add(box(3, 0.25, 0.25, mat.light, 1.2, 11.8, 0));
      l.add(box(2, 0.4, 0.8, mat.light, 2.2, 11.6, 0));
      l.add(
        box(
          1.6,
          0.15,
          0.6,
          new THREE.MeshStandardMaterial({
            color: 0xffeebb,
            emissive: 0xffeebb,
            emissiveIntensity: 0.5,
          }),
          2.2,
          11.4,
          0,
        ),
      );
      l.position.set(x, 0, z);
      lights.add(l);
    });
    registerAsset(lights, {
      id: "lighting_poles",
      label: "Industrial Lighting",
      baseColor: 0x2b2f36,
      status: "safe",
    });

    // ── Trees ───────────────────────────────────────────────────────────
    const trees = new THREE.Group();
    const treeSpots: Array<[number, number]> = [];
    for (let x = -150; x <= 150; x += 10) {
      treeSpots.push([x, -125], [x, 125]);
    }
    for (let z = -115; z <= 115; z += 10) {
      treeSpots.push([-155, z], [155, z]);
    }
    (
      [
        [-130, 100],
        [130, 100],
        [-130, -80],
        [130, -80],
      ] as const
    ).forEach(([cx, cz]) => {
      for (let i = 0; i < 6; i++) {
        treeSpots.push([cx + (Math.random() - 0.5) * 30, cz + (Math.random() - 0.5) * 20]);
      }
    });
    treeSpots.forEach(([x, z]) => {
      const t = new THREE.Group();
      t.add(cyl(0.25, 0.35, 2.2, mat.trunk, 0, 1.1, 0));
      const leaves = new THREE.Mesh(
        new THREE.SphereGeometry(1.4 + Math.random() * 0.5, 10, 8),
        mat.leaves,
      );
      leaves.position.y = 3;
      leaves.scale.y = 1.2;
      t.add(leaves);
      t.position.set(x, 0, z);
      trees.add(t);
    });
    registerAsset(trees, { id: "trees", label: "Trees", baseColor: 0x1a4a20, status: "neutral" });

    // ══════════════════════════════════════════════════════════════════════
    //  IoT SENSORS
    // ══════════════════════════════════════════════════════════════════════

    // Per-zone crew markers, reconciled against the backend's worker counts.
    // The scene previously carried 20 invented sensors, 6 CCTV cameras, 14
    // named workers on scripted patrol routes and 3 roaming vehicles. None of
    // it existed in the backend, so it animated activity the plant was not
    // actually reporting. Zone telemetry is the only per-location data the API
    // exposes, so that is what the scene shows.
    const workersGroup = new THREE.Group();
    workersGroup.userData = { id: "workers_group" };
    root.add(workersGroup);

    const crewByZone = new Map<string, { models: THREE.Group[]; count: number }>();

    const disposeCrew = (models: THREE.Group[]) => {
      models.forEach((m) => {
        workersGroup.remove(m);
        m.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else if (mat) mat.dispose();
        });
      });
    };

    /** Place `workers_in_zone` figures around each zone's floor-plan position. */
    const applyCrew = () => {
      const zones = liveZonesRef.current;
      if (!zones) return;
      const seen = new Set<string>();

      zones.forEach((z) => {
        seen.add(z.zone_id);
        const count = Math.max(0, Math.min(24, z.workers_in_zone));
        const existing = crewByZone.get(z.zone_id);
        if (existing && existing.count === count) return;
        if (existing) disposeCrew(existing.models);

        const [cx, cz] = gridToScene(z.x, z.y);
        const models: THREE.Group[] = [];
        for (let k = 0; k < count; k++) {
          // Deterministic ring placement: no per-frame jitter, no fake routes.
          const ang = (k / Math.max(count, 1)) * Math.PI * 2;
          const radius = 9 + (k % 3) * 3.5;
          const model = createWorkerModel(0xf5b301, "");
          model.position.set(cx + Math.cos(ang) * radius, 0, cz + Math.sin(ang) * radius);
          model.rotation.y = -ang;
          model.userData.zone = z.zone_id;
          workersGroup.add(model);
          models.push(model);
        }
        crewByZone.set(z.zone_id, { models, count });
      });

      crewByZone.forEach((entry, id) => {
        if (!seen.has(id)) {
          disposeCrew(entry.models);
          crewByZone.delete(id);
        }
      });
    };

    // ══════════════════════════════════════════════════════════════════════
    //  EMERGENCY EQUIPMENT
    // ══════════════════════════════════════════════════════════════════════

    const emergencyGroup = new THREE.Group();
    const alarmLights: THREE.Mesh[] = [];
    EMERGENCY_EQUIPMENT.forEach((eq) => {
      let model: THREE.Group;
      switch (eq.type) {
        case "fire_extinguisher":
          model = createFireExtinguisher(eq.position);
          break;
        case "emergency_exit":
          model = createEmergencyExitSign(eq.position);
          break;
        case "alarm_pole": {
          model = createAlarmPole(eq.position);
          if (model.userData.alarmLight) alarmLights.push(model.userData.alarmLight);
          break;
        }
        case "fire_station":
          model = createFireStation(eq.position);
          break;
        case "medical_room":
          model = createMedicalRoom(eq.position);
          break;
        default:
          return;
      }
      model.userData.equipmentId = eq.id;
      model.userData.equipmentName = eq.name;
      emergencyGroup.add(model);
    });
    emergencyGroup.userData = { id: "emergency_group" };
    root.add(emergencyGroup);

    // ══════════════════════════════════════════════════════════════════════
    //  EMERGENCY EVACUATION ROUTES (green arrows on ground)
    // ══════════════════════════════════════════════════════════════════════

    const routesGroup = new THREE.Group();
    const routeArrows: THREE.Mesh[] = [];
    EVACUATION_ROUTES.forEach((route) => {
      const zone = SAFETY_ZONES.find((z) => z.id === route.fromZone);
      const color = zone?.color ?? 0x22c55e;

      for (let i = 0; i < route.waypoints.length - 1; i++) {
        const from = route.waypoints[i];
        const to = route.waypoints[i + 1];
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        const angle = Math.atan2(dx, dz);

        // Arrow segment
        const arrowCount = Math.max(1, Math.floor(len / 8));
        for (let a = 0; a < arrowCount; a++) {
          const t = (a + 0.5) / arrowCount;
          const px = from.x + dx * t;
          const pz = from.z + dz * t;

          // Arrow triangle
          const shape = new THREE.Shape();
          shape.moveTo(0, 1.5);
          shape.lineTo(-1, -0.5);
          shape.lineTo(1, -0.5);
          shape.closePath();

          const arrowGeo = new THREE.ShapeGeometry(shape);
          const arrow = new THREE.Mesh(
            arrowGeo,
            new THREE.MeshBasicMaterial({
              color: 0x22c55e,
              transparent: true,
              opacity: 0.5,
              side: THREE.DoubleSide,
            }),
          );
          arrow.rotation.x = -Math.PI / 2;
          arrow.rotation.z = -angle;
          arrow.position.set(px, 0.15, pz);
          routesGroup.add(arrow);
          routeArrows.push(arrow);
        }
      }
    });
    routesGroup.visible = false;
    routesGroup.userData = { id: "routes_group" };
    root.add(routesGroup);

    // ══════════════════════════════════════════════════════════════════════
    //  WEATHER STATION
    // ══════════════════════════════════════════════════════════════════════

    const weatherStation = new THREE.Group();
    const wsMast = cyl(0.15, 0.2, 8, mat.steelDark, 0, 4, 0);
    const wsBase = box(2, 0.4, 2, mat.steelDark, 0, 0.2, 0);
    // Anemometer
    const anemometer = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.1, 0.1), mat.steel);
      arm.rotation.y = (i / 3) * Math.PI * 2;
      const cup = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6, 0, Math.PI), mat.steelDark);
      cup.position.x = 1.2;
      cup.rotation.y = (i / 3) * Math.PI * 2;
      anemometer.add(arm, cup);
    }
    anemometer.position.y = 8.2;
    // Wind vane
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 2), mat.chimneyBand);
    vane.position.y = 7.5;
    weatherStation.add(wsMast, wsBase, anemometer, vane);
    weatherStation.position.set(145, 0, 115);
    const wsLabel = createTextSprite("🌤 Weather Station", { fontSize: 20, bgColor: "#1e3a5f" });
    wsLabel.position.y = 10;
    weatherStation.add(wsLabel);
    weatherStation.userData = { id: "weather_station", anemometer, vane };
    root.add(weatherStation);

    // ══════════════════════════════════════════════════════════════════════
    //  SMOKE PARTICLE SYSTEM (chimneys + boiler)
    // ══════════════════════════════════════════════════════════════════════

    const smokeParticles: Array<{
      mesh: THREE.Mesh;
      vel: THREE.Vector3;
      life: number;
      maxLife: number;
      origin: THREE.Vector3;
    }> = [];
    const smokeMat = new THREE.MeshBasicMaterial({
      color: 0x8a9aaa,
      transparent: true,
      opacity: 0.15,
    });

    const smokeOrigins = [
      new THREE.Vector3(40, 43, 90),
      new THREE.Vector3(50, 43, 105),
      new THREE.Vector3(-40, 43, -100),
      new THREE.Vector3(54, 27, 40),
      new THREE.Vector3(66, 27, 40),
    ];

    const spawnSmoke = (origin: THREE.Vector3) => {
      const geo = new THREE.SphereGeometry(0.4 + Math.random() * 0.6, 6, 6);
      const mesh = new THREE.Mesh(geo, smokeMat.clone());
      mesh.position
        .copy(origin)
        .add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5));
      mesh.renderOrder = 10;
      scene.add(mesh);
      smokeParticles.push({
        mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 0.02,
          0.03 + Math.random() * 0.02,
          (Math.random() - 0.5) * 0.02,
        ),
        life: 0,
        maxLife: 120 + Math.random() * 60,
        origin,
      });
    };

    // ══════════════════════════════════════════════════════════════════════
    //  GAS LEAK PARTICLES (subtle, near Tank A)
    // ══════════════════════════════════════════════════════════════════════

    const gasParticles: Array<{
      mesh: THREE.Mesh;
      vel: THREE.Vector3;
      life: number;
      maxLife: number;
      peak: number;
    }> = [];
    const gasLeakOrigin = new THREE.Vector3(-115, 8, 80);
    const gasMat = new THREE.MeshBasicMaterial({
      color: 0xa8e6a0,
      transparent: true,
      opacity: 0.04,
    });

    /** `intensity` (0-1) drives plume size, density, opacity and hue (green → red). */
    const spawnGas = (intensity: number) => {
      const geo = new THREE.SphereGeometry(
        (0.8 + Math.random() * 1.2) * (1 + intensity * 0.9),
        6,
        6,
      );
      const material = gasMat.clone();
      const peak = 0.05 + intensity * 0.22;
      material.opacity = peak;
      material.color.setHSL(0.33 - intensity * 0.3, 0.75, 0.55);

      const mesh = new THREE.Mesh(geo, material);
      mesh.position
        .copy(gasLeakOrigin)
        .add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 3,
            Math.random() * 2,
            (Math.random() - 0.5) * 3,
          ),
        );
      mesh.renderOrder = 10;
      scene.add(mesh);
      gasParticles.push({
        mesh,
        vel: new THREE.Vector3(
          0.01 + Math.random() * 0.01,
          0.005 + intensity * 0.02,
          (Math.random() - 0.5) * 0.005,
        ),
        life: 0,
        maxLife: 200 + Math.random() * 100,
        peak,
      });
    };

    // ══════════════════════════════════════════════════════════════════════
    //  SCENARIO RIG — hot work + alarm beacons, toggled by the demo timeline
    // ══════════════════════════════════════════════════════════════════════

    // ── Hot-work welding arc, sited just downwind of the leak ────────────
    const hotWorkGroup = new THREE.Group();
    hotWorkGroup.position.set(-96, 0, 72);
    const weldArc = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.95 }),
    );
    weldArc.position.y = 4;
    const weldLight = new THREE.PointLight(0xffc766, 0, 60, 2);
    weldLight.position.set(0, 5, 0);
    hotWorkGroup.add(weldArc, weldLight);
    hotWorkGroup.visible = false;
    root.add(hotWorkGroup);

    const sparks: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number }> =
      [];
    const sparkGeo = new THREE.SphereGeometry(0.2, 4, 4);
    const spawnSpark = () => {
      const mesh = new THREE.Mesh(
        sparkGeo,
        new THREE.MeshBasicMaterial({ color: 0xffb703, transparent: true }),
      );
      mesh.position.set(0, 4, 0);
      hotWorkGroup.add(mesh);
      sparks.push({
        mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 0.6,
          Math.random() * 0.4,
          (Math.random() - 0.5) * 0.6,
        ),
        life: 0,
        maxLife: 28 + Math.random() * 20,
      });
    };

    // ── Site alarm beacons ──────────────────────────────────────────────
    const alarmGroup = new THREE.Group();
    const beacons: THREE.Mesh[] = [];
    (
      [
        [-115, 80],
        [-60, 30],
        [30, -20],
        [120, 95],
      ] as Array<[number, number]>
    ).forEach(([bx, bz]) => {
      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(1.7, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.9 }),
      );
      beacon.position.set(bx, 15, bz);
      alarmGroup.add(beacon);
      beacons.push(beacon);
    });
    alarmGroup.visible = false;
    root.add(alarmGroup);

    // ══════════════════════════════════════════════════════════════════════
    //  AI RISK HEATMAP OVERLAY
    // ══════════════════════════════════════════════════════════════════════

    const heatmapGroup = new THREE.Group();

    const makeRiskLabel = (risk: number) =>
      createTextSprite(`⚠ ${risk}% Risk`, {
        fontSize: 26,
        bgColor: risk > 80 ? "#991b1b" : risk > 60 ? "#854d0e" : "#14532d",
        bgOpacity: 0.9,
      });

    /** Label for a backend zone: name, real risk, gas and crew exposure. */
    const makeLiveLabel = (z: LiveZone, pct: number) =>
      createTextSprite(
        `${z.name}  ${pct}%  ·  ${z.gas_lel.toFixed(1)}% LEL  ·  ${z.workers_in_zone}👷`,
        {
          fontSize: 24,
          bgColor: pct > 60 ? "#991b1b" : pct > 30 ? "#854d0e" : "#14532d",
          bgOpacity: 0.92,
        },
      );

    const heatZones = SAFETY_ZONES.map((zone) => {
      const heatPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(zone.bounds.w * 0.9, zone.bounds.d * 0.9),
        new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide }),
      );
      heatPlane.rotation.x = -Math.PI / 2;
      heatPlane.position.set(zone.bounds.x, 0.3, zone.bounds.z);

      const riskLabel = makeRiskLabel(zone.riskLevel);
      riskLabel.position.set(zone.bounds.x, 4, zone.bounds.z);

      heatmapGroup.add(heatPlane, riskLabel);
      return {
        plane: heatPlane,
        label: riskLabel,
        base: zone.riskLevel,
        x: zone.bounds.x,
        z: zone.bounds.z,
        applied: -1, // force the first paint
      };
    });

    /**
     * Repaint zone planes and labels for the current simulated risk. Cheap to
     * call every frame: each zone early-returns unless its rounded risk moved.
     */
    const applyHeat = () => {
      const sim = simRiskRef.current;
      heatZones.forEach((hz) => {
        const effective =
          sim == null
            ? hz.base
            : Math.round(Math.max(0, Math.min(100, hz.base + (sim - ZONE_BASELINE_AVG))));
        if (effective === hz.applied) return;
        hz.applied = effective;

        const intensity = effective / 100;
        const mat = hz.plane.material as THREE.MeshBasicMaterial;
        mat.color.setHSL((1 - intensity) * 0.35, 0.8, 0.4 + intensity * 0.2);
        mat.opacity = 0.08 + intensity * 0.12;

        // Sprite text is baked into a canvas texture, so the label is rebuilt.
        heatmapGroup.remove(hz.label);
        const oldMat = hz.label.material as THREE.SpriteMaterial;
        oldMat.map?.dispose();
        oldMat.dispose();

        const next = makeRiskLabel(effective);
        next.position.set(hz.x, 4, hz.z);
        heatmapGroup.add(next);
        hz.label = next;
      });
    };
    applyHeat();

    heatmapGroup.userData = { id: "heatmap_group" };
    root.add(heatmapGroup);

    // ══════════════════════════════════════════════════════════════════════
    //  LIVE ZONE OVERLAY — real zones streamed from the backend
    // ══════════════════════════════════════════════════════════════════════

    const liveGroup = new THREE.Group();
    liveGroup.userData = { id: "live_zone_group" };
    root.add(liveGroup);

    interface LiveMarker {
      pad: THREE.Mesh;
      column: THREE.Mesh;
      label: THREE.Sprite;
      applied: string;
      sx: number;
      sz: number;
    }
    const liveMarkers = new Map<string, LiveMarker>();

    const disposeMarker = (m: LiveMarker) => {
      [m.pad, m.column].forEach((mesh) => {
        liveGroup.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      });
      liveGroup.remove(m.label);
      const lm = m.label.material as THREE.SpriteMaterial;
      lm.map?.dispose();
      lm.dispose();
    };

    /**
     * Reconcile the overlay against the latest backend payload: add markers for
     * new zones, restyle changed ones, drop those that disappeared. Keyed on a
     * cheap signature so an unchanged poll costs nothing.
     */
    const applyLiveZones = () => {
      const zones = liveZonesRef.current;
      if (!zones || zones.length === 0) {
        if (liveMarkers.size) {
          liveMarkers.forEach(disposeMarker);
          liveMarkers.clear();
        }
        liveGroup.visible = false;
        return;
      }
      liveGroup.visible = true;

      const seen = new Set<string>();
      zones.forEach((z) => {
        seen.add(z.zone_id);
        const pct = Math.round(Math.max(0, Math.min(1, z.risk)) * 100);
        const sig = `${pct}|${z.gas_lel.toFixed(1)}|${z.workers_in_zone}|${z.baseline_alarm}`;
        const existing = liveMarkers.get(z.zone_id);
        if (existing && existing.applied === sig) return;

        const intensity = pct / 100;
        const colour = new THREE.Color().setHSL((1 - intensity) * 0.35, 0.85, 0.5);
        const [sx, sz] = gridToScene(z.x, z.y);

        if (existing) {
          // Restyle in place — geometry and position are unchanged.
          (existing.pad.material as THREE.MeshBasicMaterial).color.copy(colour);
          (existing.pad.material as THREE.MeshBasicMaterial).opacity = 0.12 + intensity * 0.3;
          (existing.column.material as THREE.MeshBasicMaterial).color.copy(colour);
          existing.column.scale.y = Math.max(0.05, intensity);
          existing.column.position.y = (30 * Math.max(0.05, intensity)) / 2;

          liveGroup.remove(existing.label);
          const om = existing.label.material as THREE.SpriteMaterial;
          om.map?.dispose();
          om.dispose();
          const label = makeLiveLabel(z, pct);
          label.position.set(sx, 36, sz);
          liveGroup.add(label);
          existing.label = label;
          existing.applied = sig;
          return;
        }

        const pad = new THREE.Mesh(
          new THREE.CircleGeometry(16, 32),
          new THREE.MeshBasicMaterial({
            color: colour,
            transparent: true,
            opacity: 0.12 + intensity * 0.3,
            side: THREE.DoubleSide,
          }),
        );
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(sx, 0.45, sz);

        // Height encodes risk, so the dangerous zone is legible from any angle.
        const column = new THREE.Mesh(
          new THREE.CylinderGeometry(2.2, 2.2, 30, 12),
          new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.55 }),
        );
        const h = Math.max(0.05, intensity);
        column.scale.y = h;
        column.position.set(sx, (30 * h) / 2, sz);

        const label = makeLiveLabel(z, pct);
        label.position.set(sx, 36, sz);

        liveGroup.add(pad, column, label);
        liveMarkers.set(z.zone_id, { pad, column, label, applied: sig, sx, sz });
      });

      liveMarkers.forEach((m, id) => {
        if (!seen.has(id)) {
          disposeMarker(m);
          liveMarkers.delete(id);
        }
      });
    };

    // ══════════════════════════════════════════════════════════════════════
    //  RAYCASTING (click to select)
    // ══════════════════════════════════════════════════════════════════════

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let selectedObj: THREE.Object3D | null = null;
    const outlineMeshes: THREE.Mesh[] = [];

    const clearSelection = () => {
      outlineMeshes.forEach((m) => {
        scene.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      });
      outlineMeshes.length = 0;
      selectedObj = null;
    };

    /** Draw a pulsing bounding-box cage around the picked asset. */
    const highlight = (target: THREE.Object3D) => {
      const bounds = new THREE.Box3().setFromObject(target);
      if (bounds.isEmpty()) return;
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      bounds.getSize(size);
      bounds.getCenter(center);

      const cage = new THREE.Mesh(
        new THREE.BoxGeometry(size.x * 1.08 + 1, size.y * 1.08 + 1, size.z * 1.08 + 1),
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          wireframe: true,
          transparent: true,
          opacity: 0.9,
        }),
      );
      cage.position.copy(center);
      cage.userData.isOutline = true;
      scene.add(cage);
      outlineMeshes.push(cage);
    };

    const canvas = renderer.domElement;

    const onClick = (e: MouseEvent) => {
      // Don't select if we were dragging
      if (wasDragging) return;

      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      const intersects = raycaster.intersectObjects(root.children, true);
      clearSelection();

      if (intersects.length > 0) {
        // Walk up to find registered asset
        let target = intersects[0].object;
        let found: THREE.Object3D | null = null;
        while (target) {
          if (target.userData?.id && assets.includes(target)) {
            found = target;
            break;
          }
          if (
            target.userData?.sensorId ||
            target.userData?.cctvId ||
            target.userData?.workerId ||
            target.userData?.vehicleId ||
            target.userData?.equipmentId
          ) {
            found = target;
            break;
          }
          target = target.parent!;
        }

        if (found) {
          selectedObj = found;

          // Identity only. This used to synthesise sensor readings, a random
          // "AI prediction" and a recommendation picked at random from a fixed
          // list — none of it came from the backend. Risk, telemetry and
          // recommendations belong to the zone panels, which read the API.
          const id = found.userData.id || found.userData.equipmentId || "unknown";
          const name = found.userData.label || found.userData.equipmentName || id;
          const zone = found.userData.zone || "";
          const building = BUILDINGS.find((b) => b.id === id);
          const tank = TANKS.find((t) => t.id === id);

          // NOTE: `a || b ? x : y` parses as `(a || b) ? x : y`, which made every
          // asset carrying a `type` report as "Tank". Parenthesised explicitly.
          const assetType =
            building?.type ?? (tank ? "Storage Tank" : found.userData.type || "Structure");
          const assetDescription =
            building?.description ??
            found.userData.description ??
            (tank?.contents ? `Contains ${tank.contents}` : "");

          const zoneData = SAFETY_ZONES.find((z) => z.id === (zone as ZoneId));

          highlight(found);

          cbRef.current.onSelectAsset?.({
            id,
            name,
            type: assetType,
            zone: zoneData?.name || zone,
            description: assetDescription,
          });
        }
      } else {
        cbRef.current.onSelectAsset?.(null);
      }
    };

    // ── Interactions (drag to orbit, wheel to zoom) ─────────────────────
    let isDragging = false;
    let lastX = 0,
      lastY = 0;
    let dragDistance = 0;
    let wasDragging = false;

    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none";

    const onDown = (e: PointerEvent) => {
      isDragging = true;
      wasDragging = false;
      dragDistance = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      dragDistance += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX;
      lastY = e.clientY;
      camAngle -= dx * 0.005;
      pitchOffset = Math.max(-60, Math.min(60, pitchOffset + dy * 0.5));
      updateCamera();
    };
    const onUp = (e: PointerEvent) => {
      wasDragging = dragDistance > 5;
      isDragging = false;
      canvas.style.cursor = "grab";
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom = Math.max(0.4, Math.min(2.5, zoom + e.deltaY * 0.001));
      updateCamera();
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("click", onClick);

    // ── Resize ──────────────────────────────────────────────────────────
    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return; // panel collapsed / not laid out yet
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);
    // The panel can resize without the window doing so (sidebar collapse,
    // layout reflow), so observe the mount element directly.
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(mount);

    // ══════════════════════════════════════════════════════════════════════
    //  ANIMATION LOOP
    // ══════════════════════════════════════════════════════════════════════

    let frameId = 0;
    let smokeTimer = 0;
    let gasTimer = 0;

    const tick = () => {
      frameId = requestAnimationFrame(tick);
      const t = timeRef.current++;

      // ── Toggle visibility from props (read through a ref: this loop was
      //    built once, so the mount-time closure would never see updates) ──
      const L = layersRef.current;
      const SC = scenarioRef.current;
      zoneOverlays.visible = L.zones;
      heatmapGroup.visible = L.heatmap;
      // An active evacuation forces the routes on regardless of the layer toggle.
      routesGroup.visible = L.routes || SC.evacuation;

      // ── Live backend zones take precedence over the authored heatmap ──
      applyLiveZones();
      const hasLive = liveMarkers.size > 0;
      heatmapGroup.visible = L.heatmap && !hasLive;
      liveGroup.visible = L.heatmap && hasLive;
      if (heatmapGroup.visible) applyHeat();

      // ── Crew markers follow the backend's per-zone worker counts ──────
      workersGroup.visible = L.workers;
      if (L.workers) applyCrew();

      // ── Weather station anemometer spin ──────────────────────────────
      const anemometerRef = weatherStation.userData.anemometer as THREE.Group;
      if (anemometerRef) anemometerRef.rotation.y += 0.04;

      // ── Evacuation: crew markers converge on the assembly pad ───────
      if (SC.evacuation) {
        let wi = 0;
        crewByZone.forEach((entry) => {
          entry.models.forEach((m) => {
            const ang = (wi++ / 14) * Math.PI * 2;
            const tx = 130 + Math.cos(ang) * 7;
            const tz = 100 + Math.sin(ang) * 7;
            const dx = tx - m.position.x;
            const dz = tz - m.position.z;
            m.position.x += dx * 0.03;
            m.position.z += dz * 0.03;
            if (Math.abs(dx) > 0.5 || Math.abs(dz) > 0.5) {
              m.rotation.y = Math.atan2(dx, dz);
              m.position.y = Math.abs(Math.sin(t * 0.25 + wi)) * 0.22; // hurried gait
            } else {
              m.position.y = 0;
            }
          });
        });
      }

      // ── Pipe flow particles ───────────────────────────────────────────
      pipeFlowParticles.forEach((p) => {
        const { from, to, speed } = p.userData;
        p.userData.offset = (p.userData.offset + speed) % 1;
        const t2 = p.userData.offset;
        p.position.x = from.x + (to.x - from.x) * t2;
        p.position.z = from.z + (to.z - from.z) * t2;
        (p.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(t2 * Math.PI) * 0.3;
      });

      // ── Smoke particles ───────────────────────────────────────────────
      smokeTimer++;
      if (smokeTimer >= 8) {
        smokeTimer = 0;
        smokeOrigins.forEach((origin) => {
          if (smokeParticles.length < 80) spawnSmoke(origin);
        });
      }
      for (let i = smokeParticles.length - 1; i >= 0; i--) {
        const sp = smokeParticles[i];
        sp.life++;
        sp.mesh.position.add(sp.vel);
        sp.mesh.scale.multiplyScalar(1.008);
        const alpha = 1 - sp.life / sp.maxLife;
        (sp.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.12 * alpha);
        if (sp.life >= sp.maxLife) {
          scene.remove(sp.mesh);
          sp.mesh.geometry.dispose();
          (sp.mesh.material as THREE.Material).dispose();
          smokeParticles.splice(i, 1);
        }
      }

      // ── Gas leak particles (rate + density scale with the leak) ───────
      const leak = Math.max(0, Math.min(1, SC.gasLeak));
      gasTimer++;
      if (leak > 0.01) {
        const spawnEvery = Math.max(3, Math.round(20 - leak * 17));
        const cap = Math.round(15 + leak * 75);
        if (gasTimer >= spawnEvery) {
          gasTimer = 0;
          if (gasParticles.length < cap) spawnGas(leak);
        }
      }
      for (let i = gasParticles.length - 1; i >= 0; i--) {
        const gp = gasParticles[i];
        gp.life++;
        gp.mesh.position.add(gp.vel);
        gp.mesh.scale.multiplyScalar(1.005);
        const alpha = 1 - gp.life / gp.maxLife;
        (gp.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, gp.peak * alpha);
        if (gp.life >= gp.maxLife) {
          scene.remove(gp.mesh);
          gp.mesh.geometry.dispose();
          (gp.mesh.material as THREE.Material).dispose();
          gasParticles.splice(i, 1);
        }
      }

      // ── Hot work: flickering arc, work light and sparks ───────────────
      hotWorkGroup.visible = SC.hotWork;
      if (SC.hotWork) {
        const flicker = 0.6 + Math.random() * 0.4;
        (weldArc.material as THREE.MeshBasicMaterial).opacity = flicker;
        weldArc.scale.setScalar(0.85 + flicker * 0.35);
        weldLight.intensity = flicker * 3.2;
        if (sparks.length < 40 && Math.random() < 0.6) spawnSpark();
      } else {
        weldLight.intensity = 0;
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const sp = sparks[i];
        sp.life++;
        sp.vel.y -= 0.022; // gravity
        sp.mesh.position.add(sp.vel);
        (sp.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(
          0,
          1 - sp.life / sp.maxLife,
        );
        if (sp.life >= sp.maxLife || sp.mesh.position.y < 0) {
          hotWorkGroup.remove(sp.mesh);
          (sp.mesh.material as THREE.Material).dispose();
          sparks.splice(i, 1);
        }
      }

      // ── Site alarm beacons ────────────────────────────────────────────
      alarmGroup.visible = SC.alarm;
      if (SC.alarm) {
        beacons.forEach((b, i) => {
          const phase = Math.abs(Math.sin(t * 0.12 + i * 0.5));
          (b.material as THREE.MeshBasicMaterial).opacity = 0.25 + phase * 0.75;
          b.scale.setScalar(0.8 + phase * 0.5);
        });
      }

      // ── Alarm light flash ─────────────────────────────────────────────
      alarmLights.forEach((light) => {
        (light.material as THREE.MeshStandardMaterial).emissiveIntensity =
          0.2 + Math.abs(Math.sin(t * 0.08)) * 0.8;
      });

      // ── Evacuation route arrow pulse ──────────────────────────────────
      if (routesGroup.visible) {
        routeArrows.forEach((arrow, i) => {
          (arrow.material as THREE.MeshBasicMaterial).opacity =
            0.3 + Math.abs(Math.sin(t * 0.04 + i * 0.2)) * 0.4;
        });
      }

      // ── Selection cage pulse ──────────────────────────────────────────
      outlineMeshes.forEach((m) => {
        (m.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.abs(Math.sin(t * 0.06)) * 0.5;
      });

      renderer.render(scene, camera);
    };
    tick();

    // ── Cleanup ─────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
      resetCameraRef.current = null;
      sceneRef.current = null;
      rendererRef.current = null;
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("click", onClick);
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const material = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((x) => x.dispose());
        else if (material) material.dispose();
      });
      smokeParticles.forEach((sp) => {
        scene.remove(sp.mesh);
        sp.mesh.geometry.dispose();
        (sp.mesh.material as THREE.Material).dispose();
      });
      gasParticles.forEach((gp) => {
        scene.remove(gp.mesh);
        gp.mesh.geometry.dispose();
        (gp.mesh.material as THREE.Material).dispose();
      });
      sparks.forEach((sp) => {
        hotWorkGroup.remove(sp.mesh);
        (sp.mesh.material as THREE.Material).dispose();
      });
      sparkGeo.dispose();
      liveMarkers.forEach(disposeMarker);
      liveMarkers.clear();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
    // Scene is built once and driven imperatively thereafter; live values are
    // read through refs, so this genuinely has no dependencies.
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  //  PROP-DRIVEN EFFECTS
  // ════════════════════════════════════════════════════════════════════════

  // Recolour the backdrop in place rather than rebuilding the whole scene.
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (!scene || !renderer) return;
    const backdrop = BACKDROP[theme];
    scene.background = new THREE.Color(backdrop.clear);
    scene.fog = new THREE.Fog(backdrop.clear, backdrop.fogNear, backdrop.fogFar);
    renderer.setClearColor(backdrop.clear, 1);
  }, [theme]);

  // Re-frame the camera whenever the host bumps `resetSignal`.
  useEffect(() => {
    if (resetSignal > 0) resetCameraRef.current?.();
  }, [resetSignal]);

  return <div ref={mountRef} className={className ?? "h-full w-full"} />;
}
