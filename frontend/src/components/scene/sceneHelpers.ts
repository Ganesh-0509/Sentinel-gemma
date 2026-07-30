/**
 * Three.js helper utilities for the Digital Twin scene.
 * Provides text sprite creation, simple geometry factories, and label generation.
 */
import * as THREE from "three";

// ─── Text Sprite (canvas-based floating labels) ──────────────────────────────

export function createTextSprite(
  text: string,
  opts: {
    fontSize?: number;
    color?: string;
    bgColor?: string;
    bgOpacity?: number;
    padding?: number;
    borderRadius?: number;
    maxWidth?: number;
    icon?: string;
  } = {},
): THREE.Sprite {
  const {
    fontSize = 28,
    color = "#ffffff",
    bgColor = "#000000",
    bgOpacity = 0.7,
    padding = 12,
    maxWidth = 512,
    icon,
  } = opts;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  const font = `bold ${fontSize}px 'Inter', 'Segoe UI', system-ui, sans-serif`;
  ctx.font = font;

  const displayText = icon ? `${icon} ${text}` : text;
  const measured = ctx.measureText(displayText);
  const textW = Math.min(measured.width, maxWidth);
  const textH = fontSize * 1.3;

  canvas.width = textW + padding * 2;
  canvas.height = textH + padding * 2;

  // Background
  ctx.fillStyle = bgColor;
  ctx.globalAlpha = bgOpacity;
  const r = opts.borderRadius ?? 8;
  roundRect(ctx, 0, 0, canvas.width, canvas.height, r);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Text
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(displayText, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(canvas.width / 28, canvas.height / 28, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Simple geometry factories ───────────────────────────────────────────────

export function box(
  w: number,
  h: number,
  d: number,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

export function cyl(
  rTop: number,
  rBot: number,
  h: number,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  segs = 32,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, segs), material);
  m.position.set(x, y, z);
  return m;
}

// ─── Sensor icon (small pulsing cylinder + label) ────────────────────────────

export function createSensorMarker(
  color: number,
  position: { x: number; y: number; z: number },
  label: string,
  icon: string,
): THREE.Group {
  const g = new THREE.Group();

  // Glowing base
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 1.5, 16),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.5,
      roughness: 0.3,
    }),
  );
  base.position.y = 0.75;
  g.add(base);

  // Pulse ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1.2, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.1;
  g.add(ring);

  // Label
  const sprite = createTextSprite(label, { fontSize: 20, bgColor: "#111827", icon });
  sprite.position.y = 3;
  g.add(sprite);

  g.position.set(position.x, position.y, position.z);
  g.userData.pulseRing = ring;
  return g;
}

// ─── CCTV camera model ──────────────────────────────────────────────────────

export function createCCTVModel(
  position: { x: number; y: number; z: number },
  lookAt: { x: number; y: number; z: number },
  status: string,
): THREE.Group {
  const g = new THREE.Group();

  // Pole
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.2, position.y, 8),
    new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.6, metalness: 0.5 }),
  );
  pole.position.y = position.y / 2;
  g.add(pole);

  // Camera body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.8, 1.8),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.4, metalness: 0.6 }),
  );
  body.position.y = position.y;

  // Lens
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.4, 0.5, 12),
    new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.2, metalness: 0.8 }),
  );
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, position.y, 1);

  // Status LED
  const ledColor = status === "alert" ? 0xef4444 : 0x22c55e;
  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 8, 8),
    new THREE.MeshStandardMaterial({ color: ledColor, emissive: ledColor, emissiveIntensity: 0.8 }),
  );
  led.position.set(0.5, position.y + 0.3, 0);

  // View cone (translucent)
  const coneLen = 20;
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(8, coneLen, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: status === "alert" ? 0xef4444 : 0x3b82f6,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
    }),
  );
  cone.rotation.x = Math.PI / 2;
  cone.position.set(0, position.y - 2, coneLen / 2 + 1);

  g.add(body, lens, led, cone);

  // Orient camera toward lookAt target
  const dir = new THREE.Vector3(lookAt.x - position.x, 0, lookAt.z - position.z).normalize();
  const angle = Math.atan2(dir.x, dir.z);
  body.rotation.y = angle;
  lens.position.x = Math.sin(angle) * 1;
  lens.position.z = Math.cos(angle) * 1;
  cone.rotation.y = angle;
  cone.position.x = Math.sin(angle) * (coneLen / 2 + 1);
  cone.position.z = Math.cos(angle) * (coneLen / 2 + 1);

  g.position.set(position.x, 0, position.z);
  g.userData.led = led;
  g.userData.cone = cone;
  return g;
}

// ─── Worker model (simple humanoid) ─────────────────────────────────────────

export function createWorkerModel(helmetColor: number, name: string): THREE.Group {
  const g = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd4a574, roughness: 0.8 });
  const vestMat = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.7 });
  const pantMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.9 });
  const helmetMat = new THREE.MeshStandardMaterial({
    color: helmetColor,
    roughness: 0.5,
    metalness: 0.2,
  });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x1c1917, roughness: 0.9 });

  // Boots
  g.add(
    new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.6), bootMat).translateX(-0.3).translateY(0.2),
  );
  g.add(
    new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.6), bootMat).translateX(0.3).translateY(0.2),
  );
  // Pants / legs
  g.add(
    new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 0.4), pantMat).translateX(-0.3).translateY(0.9),
  );
  g.add(
    new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 0.4), pantMat).translateX(0.3).translateY(0.9),
  );
  // Body / vest
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1.2, 0.6), vestMat).translateY(2));
  // Arms
  g.add(
    new THREE.Mesh(new THREE.BoxGeometry(0.3, 1, 0.3), skinMat).translateX(-0.65).translateY(1.9),
  );
  g.add(
    new THREE.Mesh(new THREE.BoxGeometry(0.3, 1, 0.3), skinMat).translateX(0.65).translateY(1.9),
  );
  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), skinMat);
  head.position.y = 2.95;
  g.add(head);
  // Helmet
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    helmetMat,
  );
  helmet.position.y = 3.05;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 16), helmetMat);
  brim.position.y = 2.9;
  g.add(helmet, brim);

  // Name label
  const label = createTextSprite(name, { fontSize: 18, bgColor: "#1f2937", bgOpacity: 0.8 });
  label.position.y = 4;
  g.add(label);

  g.traverse((c) => {
    c.castShadow = true;
    c.receiveShadow = true;
  });
  return g;
}

// ─── Vehicle models ─────────────────────────────────────────────────────────

export function createVehicleModel(
  type: "forklift" | "truck" | "tanker",
  color: number,
  name: string,
): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1c1917, roughness: 0.9 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x86a7c6,
    roughness: 0.25,
    transparent: true,
    opacity: 0.7,
  });

  if (type === "forklift") {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.5, 3.5), bodyMat).translateY(1.5));
    g.add(
      new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 1.5), glassMat)
        .translateY(2.7)
        .translateZ(-0.5),
    );
    // Forks
    const forkMat = new THREE.MeshStandardMaterial({
      color: 0x6b7280,
      metalness: 0.7,
      roughness: 0.4,
    });
    g.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 3), forkMat)
        .translateX(-0.6)
        .translateY(0.4)
        .translateZ(2),
    );
    g.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 3), forkMat)
        .translateX(0.6)
        .translateY(0.4)
        .translateZ(2),
    );
    g.add(
      new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.5, 0.2), forkMat).translateY(1.6).translateZ(3.5),
    );
  } else if (type === "truck") {
    // Cab
    g.add(new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), bodyMat).translateY(2).translateZ(-3));
    g.add(
      new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.5, 0.2), glassMat)
        .translateY(2.8)
        .translateZ(-1.5),
    );
    // Cargo
    g.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(3, 3, 7),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.8 }),
      )
        .translateY(2)
        .translateZ(2),
    );
  } else {
    // Tanker cab
    g.add(new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), bodyMat).translateY(2).translateZ(-4));
    g.add(
      new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.5, 0.2), glassMat)
        .translateY(2.8)
        .translateZ(-2.5),
    );
    // Tank
    const tankMat = new THREE.MeshStandardMaterial({
      color: 0xd1d5db,
      metalness: 0.5,
      roughness: 0.4,
    });
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 8, 20), tankMat);
    tank.rotation.z = Math.PI / 2;
    tank.rotation.y = Math.PI / 2;
    tank.position.set(0, 2.2, 1);
    g.add(tank);
    // Hazard stripe
    g.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(3.1, 0.3, 0.3),
        new THREE.MeshStandardMaterial({ color: 0xef4444 }),
      )
        .translateY(0.5)
        .translateZ(-4),
    );
  }

  // Wheels (4)
  [-1, 1].forEach((side) => {
    [-2, 2].forEach((pos) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 12), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * 1.5, 0.5, pos);
      g.add(wheel);
    });
  });

  // Name label
  const label = createTextSprite(name, { fontSize: 18, bgColor: "#374151" });
  label.position.y = 5;
  g.add(label);

  g.traverse((c) => {
    c.castShadow = true;
    c.receiveShadow = true;
  });
  return g;
}

// ─── Emergency equipment models ─────────────────────────────────────────────

export function createFireExtinguisher(pos: { x: number; y: number; z: number }): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 1.5, 12),
    new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5 }),
  );
  body.position.y = 0.75;
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.2, 0.3, 8),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.5 }),
  );
  top.position.y = 1.6;
  g.add(body, top);
  g.position.set(pos.x, pos.y, pos.z);
  return g;
}

export function createEmergencyExitSign(pos: { x: number; y: number; z: number }): THREE.Group {
  const g = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 5, 8),
    new THREE.MeshStandardMaterial({ color: 0x374151, metalness: 0.5 }),
  );
  post.position.y = 2.5;
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(2.5, 1.5, 0.15),
    new THREE.MeshStandardMaterial({
      color: 0x16a34a,
      emissive: 0x16a34a,
      emissiveIntensity: 0.3,
      roughness: 0.5,
    }),
  );
  sign.position.y = 5.5;
  g.add(post, sign);

  const label = createTextSprite("EXIT", {
    fontSize: 24,
    color: "#ffffff",
    bgColor: "#16a34a",
    bgOpacity: 0.9,
  });
  label.position.y = 5.5;
  label.position.z = 0.2;
  g.add(label);

  g.position.set(pos.x, pos.y, pos.z);
  return g;
}

export function createAlarmPole(pos: { x: number; y: number; z: number }): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.25, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0x6b7280, metalness: 0.6 }),
  );
  pole.position.y = 4;

  const light = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.4 }),
  );
  light.position.y = 8.3;

  const horn = new THREE.Mesh(
    new THREE.ConeGeometry(0.4, 1.2, 8),
    new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.5, metalness: 0.3 }),
  );
  horn.rotation.z = Math.PI / 2;
  horn.position.set(0.8, 7.5, 0);

  g.add(pole, light, horn);
  g.position.set(pos.x, pos.y, pos.z);
  g.userData.alarmLight = light;
  return g;
}

export function createFireStation(pos: { x: number; y: number; z: number }): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(12, 8, 10),
    new THREE.MeshStandardMaterial({ color: 0xfef2f2, roughness: 0.8 }),
  );
  body.position.y = 4;
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(13, 0.6, 11),
    new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 }),
  );
  roof.position.y = 8.3;
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(6, 6, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.5 }),
  );
  door.position.set(0, 3, 5.1);
  g.add(body, roof, door);

  const label = createTextSprite("🚒 Fire Station", { fontSize: 22, bgColor: "#991b1b" });
  label.position.y = 10;
  g.add(label);

  g.position.set(pos.x, pos.y, pos.z);
  g.traverse((c) => {
    c.castShadow = true;
    c.receiveShadow = true;
  });
  return g;
}

export function createMedicalRoom(pos: { x: number; y: number; z: number }): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(10, 7, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }),
  );
  body.position.y = 3.5;
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(11, 0.5, 9),
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.7 }),
  );
  roof.position.y = 7.3;
  // Red cross
  const crossH = new THREE.Mesh(
    new THREE.BoxGeometry(3, 0.8, 0.2),
    new THREE.MeshStandardMaterial({ color: 0xdc2626 }),
  );
  crossH.position.set(0, 5, 4.1);
  const crossV = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 3, 0.2),
    new THREE.MeshStandardMaterial({ color: 0xdc2626 }),
  );
  crossV.position.set(0, 5, 4.1);
  g.add(body, roof, crossH, crossV);

  const label = createTextSprite("🚑 Medical Room", { fontSize: 22, bgColor: "#1e40af" });
  label.position.y = 9;
  g.add(label);

  g.position.set(pos.x, pos.y, pos.z);
  g.traverse((c) => {
    c.castShadow = true;
    c.receiveShadow = true;
  });
  return g;
}
