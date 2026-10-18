// The live 3D Dallas County. Everything is placed from real data: the county floor is painted from
// Census tract density, land use and every street; every building is its real OpenStreetMap outline at
// true size (about 650,000, see buildings.ts); trees fill yards, woods and creek bottoms.
// Window lights, the night glow of each neighborhood, snow, smoke, traffic and day/night lighting.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { GameState } from '../contracts';
import {
  BUILDINGS, CIRCUIT_BY_ID, CIRCUITS, HUB, LAMPS, LL, POWER_PLANT, REUNION, WATER_TOWER, WORLD,
  type BuildingInfo,
} from '../map/layout';
import type { MapScene, Pick, SceneUI } from '../map/types';
import { loadModel, variant, type Model } from './assets';
import { BuildingsLayer, loadBuildings, VEX, WAVE, type BuildingData } from './buildings';
import { paintGround, worldUV } from './ground';
import { Rig } from './rig';
import { Snowfall } from './snow';

type Ring = [number, number][];
interface Geo {
  county: Ring[][];
  plates: Record<string, Ring[][]>;
  outlines: Record<string, Ring[]>;
  lakes: Ring[][];
  rivers: Ring[];
  creeks: Ring[];
  interstates: Ring[];
  highways: Ring[];
  carPaths: Ring[];
  streets: { count: number; qx: number; qz: number };
  landuse: { k: 'air' | 'park' | 'golf' | 'cemetery' | 'campus'; polys: Ring[][]; runways?: [number, number, number, number][] }[];
  tracts: [number, Ring[][]][];
}

const BASE = import.meta.env.BASE_URL;
const KIT = (key: string) => `${BASE}models/${key}.glb`;
const CARS = ['sedan', 'suv', 'van', 'taxi', 'hatchback-sports', 'delivery', 'police', 'truck'];
// critical buildings: footprint and height in map units (a little larger than life, so they read)
const CRIT: Record<BuildingInfo['kind'], [number, number]> = { hospital: [0.24, 0.11], clinic: [0.12, 0.03], water: [0.26, 0.035], gas: [0.16, 0.035], school: [0.2, 0.028] };
const M = 965.6; // meters per map unit (0.6 mi)
const m2u = (meters: number) => (meters * VEX) / M; // a real height in map units
const ICE = 0x7cc4fa, ICE_NIGHT = ICE, ICE_DAY = 0x1d6fc4, AMBER = 0xf2a93b, COLD = 0xff7a45, GEN = 0xf2c94c;
const SUN_DIR = new THREE.Vector3(-35, 48, 50).normalize(); // a low February sun (~38°), so shadows read
const UP = new THREE.Vector3(0, 1, 0);
// landmarks people from Dallas look for
const BOFA = LL(32.7790, -96.8046); // Bank of America Plaza, green outline at night
const BRIDGE = LL(32.7835, -96.8192); // Margaret Hunt Hill Bridge over the Trinity
const TEXAS_STAR = LL(32.7766, -96.7612); // the Ferris wheel at Fair Park
const COTTON_BOWL = LL(32.7795, -96.7593);
const DALLAS_HALL = LL(32.8452, -96.7847); // SMU: the domed hall at the head of Bishop Boulevard
const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const lowQuality = typeof location !== 'undefined' && new URLSearchParams(location.search).get('q') === 'low';
/** ?pr=2 locks the render resolution (video takes, measuring); otherwise it adapts to the GPU. */
const lockPR = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('pr')) || 0 : 0;
const CIRCUIT_INDEX = Object.fromEntries(CIRCUITS.map((c, k) => [c.id, k]));

// ---------- lights with a flicker (towers, critical buildings) ----------
interface Lit { from: number; to: number; t0: number }
const OFF_SEQ = [1, 0.2, 0.85, 0.1, 0];
const ON_SEQ = [0, 0.6, 0.15, 0.9, 1];
function litAt(l: Lit, t: number): number {
  if (t < l.t0) return l.from;
  const p = (t - l.t0) / 300;
  if (p >= 1 || reduceMotion) return l.to;
  const seq = l.to === 0 ? OFF_SEQ : ON_SEQ;
  return seq[Math.min(seq.length - 1, Math.floor(p * seq.length))];
}
interface MatLight extends Lit { circuit: string; building?: string; mat: THREE.MeshStandardMaterial; k: number }

// ---------- small geometry helpers ----------
function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function helipadTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#3d74b5'; g.lineWidth = 8;
  g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#3d74b5'; g.font = 'bold 64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('H', 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function radialTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.12, '#e6e6e6');
  grd.addColorStop(0.4, '#9a9a9a');
  grd.addColorStop(1, '#6b6b6b');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A thought bubble with a snowflake: cold homes, up close. */
function bubbleTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(10, 20, 40, 0.35)';
  g.shadowBlur = 6;
  g.beginPath(); g.arc(64, 54, 40, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(40, 104, 9, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(28, 120, 5, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = '#2f8fdc';
  g.lineWidth = 6;
  g.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3;
    const dx = Math.cos(a) * 24, dy = Math.sin(a) * 24;
    g.beginPath(); g.moveTo(64 - dx, 54 - dy); g.lineTo(64 + dx, 54 + dy); g.stroke();
    for (const sgn of [1, -1]) {
      const ex = 64 + sgn * dx * 0.62, ey = 54 + sgn * dy * 0.62;
      const px = -Math.sin(a) * 8, py = Math.cos(a) * 8;
      g.beginPath(); g.moveTo(ex + px + sgn * dx * 0.25, ey + py + sgn * dy * 0.25); g.lineTo(ex, ey); g.lineTo(ex - px + sgn * dx * 0.25, ey - py + sgn * dy * 0.25); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const LIT_GLSL = /* glsl */ `
  float seqOff(float p) { int i = int(min(4.0, floor(p * 5.0))); return i == 0 ? 1.0 : i == 1 ? 0.2 : i == 2 ? 0.85 : i == 3 ? 0.1 : 0.0; }
  float seqOn(float p) { int i = int(min(4.0, floor(p * 5.0))); return i == 0 ? 0.0 : i == 1 ? 0.6 : i == 2 ? 0.15 : i == 3 ? 0.9 : 1.0; }
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
  }
`;

/**
 * Neighborhood plate shader additions: the night glow ripples off (or on) outward from the feed point,
 * and frost creeps in from the edges as homes get cold.
 */
function platePatch(
  mat: THREE.MeshLambertMaterial, center: [number, number], reach: number, time: THREE.IUniform, dark: boolean,
  detail?: { map: THREE.IUniform; k: THREE.IUniform },
): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = {
    uFrom: { value: dark ? 0 : 1 }, uTo: { value: dark ? 0 : 1 }, uT0: { value: -100 }, uTime: time,
    uCenter: { value: new THREE.Vector2(center[0], center[1]) }, uReach: { value: reach },
    uFrost: { value: 0 }, uFrostGlow: { value: 0 },
    uDetail: detail?.map ?? { value: null }, uDetailK: detail?.k ?? { value: 0 }, uGrain: GRAIN,
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWXZ;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vWXZ;
        uniform float uFrom, uTo, uT0, uTime, uReach, uFrost, uFrostGlow, uDetailK, uGrain;
        uniform vec2 uCenter;
        ${detail ? 'uniform sampler2D uDetail;' : ''}
        ${LIT_GLSL}
        float frostMask() {
          if (uFrost <= 0.001) return 0.0;
          float d = clamp(length(vWXZ - uCenter) / uReach, 0.0, 1.0);
          float edge = smoothstep(1.0 - uFrost * 1.25, 1.15 - uFrost * 1.25, d + 0.12 * vnoise(vWXZ * 1.7));
          float crystals = 0.15 + 0.85 * smoothstep(0.3, 0.8, vnoise(vWXZ * 7.0) * 0.55 + vnoise(vWXZ * 29.0 + 7.0) * 0.45);
          return clamp(edge * crystals * (0.35 + 0.65 * uFrost), 0.0, 1.0);
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        ${detail ? `{ vec4 dt = texture2D(uDetail, vMapUv); diffuseColor.rgb = diffuseColor.rgb * (1.0 - dt.a * uDetailK) + dt.rgb * uDetailK; }` : ''}
        // up close, fine grain (grass tufts, worn concrete) so the magnified floor doesn't look smeared
        if (uGrain > 0.001) diffuseColor.rgb *= 1.0 + uGrain * ((vnoise(vWXZ * 260.0) - 0.5) * 0.08 + (vnoise(vWXZ * 1300.0) - 0.5) * 0.07 + (vnoise(vWXZ * 5200.0) - 0.5) * 0.06);
        float fm = frostMask();
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.9, 1.0), fm * 0.8);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float d = clamp(length(vWXZ - uCenter) / uReach, 0.0, 1.0);
          float t0 = uT0 + d * ${WAVE.toFixed(2)} + hash21(floor(vWXZ * 6.0)) * 0.15;
          float lit = uTime < t0 ? uFrom : (uTime - t0 > 0.3 ? uTo : (uTo < 0.5 ? seqOff((uTime - t0) / 0.3) : seqOn((uTime - t0) / 0.3)));
          totalEmissiveRadiance *= lit;
          totalEmissiveRadiance += vec3(0.42, 0.66, 1.0) * fm * uFrostGlow;
        }`);
  };
  return u;
}

const GRAIN: THREE.IUniform = { value: 0 };

/** The plate's current lit level near its middle, to start a new ripple from where the old one is. */
function plateLit(u: Record<string, THREE.IUniform>, t: number, d: number): number {
  const t0 = (u.uT0.value as number) + d * WAVE;
  if (t < t0) return u.uFrom.value as number;
  return t - t0 > 0.3 ? (u.uTo.value as number) : (u.uFrom.value as number) * 0.5 + (u.uTo.value as number) * 0.5;
}

/** One point cloud for every smoke puff: world-sized soft sprites with their own fade. */
function smokePoints(map: THREE.Texture): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PUFFS * 3), 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAX_PUFFS), 1));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(MAX_PUFFS), 1));
  g.setDrawRange(0, 0);
  const pts = new THREE.Points(g, new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uMap: { value: map }, uScale: { value: 1 }, uColor: { value: new THREE.Color(0xe9eef5) } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute float aAlpha; uniform float uScale; varying float vA;
      void main() { vA = aAlpha; gl_PointSize = aSize * uScale; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform vec3 uColor; varying float vA;
      void main() { float a = texture2D(uMap, gl_PointCoord).a * vA; if (a < 0.004) discard; gl_FragColor = vec4(uColor, a); }`,
  }));
  pts.frustumCulled = false;
  return pts;
}

/** Shape in the XY plane from rings in (x, z), for meshes rotated -90° about X (so +Y faces up). */
function shapeOf(rings: Ring[]): THREE.Shape {
  const s = new THREE.Shape(rings[0].map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of rings.slice(1)) s.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  return s;
}

/** Flat ribbons along polylines (XZ plane, y = 0), optionally dashed, merged into one geometry. */
function ribbons(lines: Ring[], width: number, dash?: [number, number]): THREE.BufferGeometry {
  const pos: number[] = [];
  const hw = width / 2;
  for (const line of lines) {
    let carry = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, az] = line[i], [bx, bz] = line[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len, nx = -uz * hw, nz = ux * hw;
      const pieces: [number, number][] = [];
      if (!dash) pieces.push([-hw * 0.9, len + hw * 0.9]);
      else {
        for (let s = -carry; s < len; s += dash[0] + dash[1]) pieces.push([Math.max(0, s), Math.min(len, s + dash[0])]);
        carry = (carry + len) % (dash[0] + dash[1]);
      }
      for (const [s0, s1] of pieces) {
        if (s1 <= s0) continue;
        const p0x = ax + ux * s0, p0z = az + uz * s0, p1x = ax + ux * s1, p1z = az + uz * s1;
        pos.push(p0x - nx, 0, p0z - nz, p0x + nx, 0, p0z + nz, p1x + nx, 0, p1z + nz);
        pos.push(p0x - nx, 0, p0z - nz, p1x + nx, 0, p1z + nz, p1x - nx, 0, p1z - nz);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function pointInRing(x: number, z: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

interface Puff { x: number; y: number; z: number; size: number; life: number; max: number; vy: number; grow: number }
const MAX_PUFFS = 320;
interface Chimney { p: THREE.Vector3; circuit: number; next: number; big: boolean }
interface CarPath { pts: Ring; cum: number[]; len: number }
interface Car { path: CarPath; s: number; dir: 1 | -1; speed: number; mesh: THREE.InstancedMesh; idx: number; centre: THREE.Matrix4; scale: number }
interface Walker { x: number; z: number; node: THREE.Mesh; speed: number }

export class World implements MapScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly rig = new Rig();
  readonly scene = new THREE.Scene();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private fxaa = new FXAAPass();
  private hemi = new THREE.HemisphereLight(0xdfefff, 0x8a9a7a, 1.6);
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private root = new THREE.Group();
  private fx = new THREE.Group();
  private outlines = new THREE.Group();
  private glowTex = glowTexture();
  private padTex = helipadTexture();
  private geo!: Geo;
  private streetPos!: Float32Array;
  private buildingData!: BuildingData;
  private models = new Map<string, Model>();
  private kitMats = new Map<THREE.Texture, THREE.MeshStandardMaterial>();
  private homes: BuildingsLayer | null = null;
  private streetU = new Map<string, Record<string, THREE.IUniform>>();
  private streetMats: THREE.MeshLambertMaterial[] = [];
  private sidewalks: THREE.Mesh | null = null;
  private textures: { ground: THREE.Texture; detail: THREE.Texture; lights: THREE.Texture } | null = null;
  private matLights: MatLight[] = [];
  private plates = new Map<string, THREE.MeshLambertMaterial>();
  private detailU = { map: { value: null as THREE.Texture | null } as THREE.IUniform, k: { value: 1 } as THREE.IUniform };
  private plateRings = new Map<string, { rings: Ring[][]; box: [number, number, number, number] }>();
  private feeders = new Map<string, { curve: THREE.QuadraticBezierCurve3; mat: THREE.LineBasicMaterial }>();
  private flow!: THREE.InstancedMesh;
  private feederPoles: THREE.Mesh[] = [];
  private chimneys: Chimney[] = [];
  private puffs: Puff[] = [];
  private smoke: THREE.Points;
  private cars: Car[] = [];
  private carMeshes: THREE.InstancedMesh[] = [];
  private headlights: THREE.Points | null = null;
  private lampPools!: THREE.InstancedMesh;
  private lampBulbs!: THREE.InstancedMesh;
  private walkers: Walker[] = [];
  private wheel: THREE.Group | null = null;
  private bridgeMat: THREE.MeshStandardMaterial | null = null;
  private starCircuit = 'C-06';
  private wheelLights: THREE.InstancedMesh | null = null;
  private pickables: THREE.Object3D[] = [];
  private tops = new Map<string, number>();
  private ringMats: { building: string; mat: THREE.MeshBasicMaterial; gen: THREE.Mesh }[] = [];
  private targetFrames: THREE.Mesh[] = [];
  private snowfall: Snowfall;
  private on: Record<string, boolean> = {};
  private bOn: Record<string, boolean> = {};
  private state: GameState | null = null;
  private ui: SceneUI = { hover: null, selected: null, tool: 'inspect' };
  private flashes: Record<string, number> = {};
  private snow = false;
  private night = 0;
  private golden = 0; // sunrise / sunset glow
  private t = 0;
  private hooks = new Set<() => void>();
  private ray = new THREE.Raycaster();
  private w = 1;
  private h = 1;
  private disposed = false;
  private walkAcc = 0;
  private tmpColor = new THREE.Color();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private outlineUnit = 0;
  private shadowKey = '';
  private pan = new THREE.Vector2();
  private bubbles: { s: THREE.Sprite; age: number; y0: number }[] = [];
  private bubbleMat = new THREE.SpriteMaterial({ map: bubbleTexture(), color: 0xc9d4e0, transparent: true, depthWrite: false, depthTest: false }); // just under the bloom threshold
  private bubbleAcc = 0;
  private plateReach: number[] = [];
  private plateU = new Map<string, Record<string, THREE.IUniform>>();
  private timeU: THREE.IUniform = { value: 0 };
  private frost = new Float32Array(16);
  private backdrop: THREE.Mesh;
  private roadMats: THREE.MeshStandardMaterial[] = [];

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(lockPR || Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = !lowQuality;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // the county barely moves: redraw shadows only when the view does
    host.appendChild(this.renderer.domElement);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(3072, 3072);
    this.sun.shadow.radius = 2.5; // soft edges, like a real sun
    Object.assign(this.sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 260 });
    this.scene.add(this.hemi, this.sun, this.sun.target, this.root, this.outlines, this.fx);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.45, 0.85);
    if (!lowQuality) this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // FXAA keeps thin streets and building edges clean for a fraction of what multisampling costs
    if (!lowQuality) this.composer.addPass(this.fxaa);

    for (const c of CIRCUITS) this.on[c.id] = true;
    for (const b of BUILDINGS) this.bOn[b.id] = true;
    this.snowfall = new Snowfall(lowQuality ? 400 : 900);
    this.smoke = smokePoints(this.glowTex);
    this.scene.add(this.smoke);
    // a soft floor of cloud far below the county, brighter under the city (snow clouds glow at night)
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(700, 700).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: radialTexture(), fog: false }));
    this.backdrop.position.set(WORLD.w / 2, -8, WORLD.h / 2);
    this.scene.add(this.backdrop);
    this.scene.add(this.snowfall.points);
    this.resize();
    let last = performance.now();
    // adaptive resolution: drop the pixel ratio on slow GPUs, raise it back when there's headroom
    const maxPR = Math.min(2, window.devicePixelRatio || 1);
    const minPR = maxPR >= 2 ? 1.5 : 1; // Retina never drops below 1.5×: below that the map looks soft next to the panels
    let acc = 0, frames = 0, fast = 0;
    const loop = (now: number) => {
      if (this.disposed) return;
      const raw = now - last;
      const dt = Math.min(100, raw);
      last = now;
      this.tick(dt);
      acc += raw; frames++;
      if (acc > 1500 && !lockPR) {
        const avg = acc / frames, pr = this.renderer.getPixelRatio();
        if (avg > 30 && pr > minPR) { this.renderer.setPixelRatio(Math.max(minPR, pr - 0.25)); this.resize(); fast = 0; }
        else if (avg < 20 && pr < maxPR && ++fast >= 2) { this.renderer.setPixelRatio(Math.min(maxPR, pr + 0.25)); this.resize(); fast = 0; }
        acc = 0; frames = 0;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  onFrame(fn: () => void): () => void { this.hooks.add(fn); return () => this.hooks.delete(fn); }

  resize(): void {
    this.w = this.host.clientWidth || 1;
    this.h = this.host.clientHeight || 1;
    this.renderer.setSize(this.w, this.h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio()); // follow the adaptive resolution
    this.composer.setSize(this.w, this.h);
    this.bloom.setSize(this.w / 4, this.h / 4); // soft glows; a quarter of the pixels is plenty
    const pr = this.renderer.getPixelRatio();
    this.fxaa.setSize(this.w * pr, this.h * pr);
    this.fxaa.enabled = pr < 1.5; // at high resolution the edges are already clean, and FXAA would only soften them
    this.rig.resize(this.w, this.h);
  }

  private v = new THREE.Vector3();
  toScreen(gx: number, gy: number, y: number, out: { x: number; y: number }): { x: number; y: number } {
    this.v.set(gx, y, gy).project(this.rig.camera);
    out.x = ((this.v.x + 1) / 2) * this.w;
    out.y = ((1 - this.v.y) / 2) * this.h;
    return out;
  }

  topOf(id: string): number { return this.tops.get(id) ?? 0.3; }

  getZoom(): number { return this.rig.zoom; }

  getNight(): number { return this.night; }

  flash(id: string): void { this.flashes[id] = this.t + 600; }

  // ---------- loading ----------
  async load(progress: (step: string, done: number) => void = () => {}): Promise<void> {
    const want = [
      'industrial/building-a', 'industrial/chimney-large', 'industrial/chimney-small', 'industrial/detail-tank-large', 'industrial/water-tower',
      ...CARS.map((c) => `cars/${c}`),
    ];
    let got = 0;
    progress('Reading the county map', 0);
    const bin = (name: string) => fetch(`${BASE}geo/${name}`).then((r) => r.arrayBuffer());
    const [geo, streets, buildings, loaded] = await Promise.all([
      fetch(`${BASE}geo/dallas.json`).then((r) => r.json() as Promise<Geo>),
      bin('streets.bin'),
      loadBuildings(BASE).then((b) => { progress('Reading 650,000 real buildings', 0.6); return b; }),
      Promise.all(want.map((k) => loadModel(KIT(k)).then((m) => { progress('Loading the power plant and cars', ++got / want.length); return [k, m] as const; }))),
    ]);
    this.buildingData = buildings;
    this.geo = geo;
    for (const [k, m] of loaded) this.models.set(k, m);
    const q = new Uint16Array(streets);
    this.streetPos = new Float32Array((q.length / 2) * 3);
    for (let i = 0, j = 0; i < q.length; i += 2, j += 3) {
      this.streetPos[j] = (q[i] / 65535) * geo.streets.qx;
      this.streetPos[j + 1] = 0.012;
      this.streetPos[j + 2] = (q[i + 1] / 65535) * geo.streets.qz;
    }
    for (const [id, rings] of Object.entries(geo.plates)) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const poly of rings) for (const [x, z] of poly[0]) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
      this.plateRings.set(id, { rings, box: [x0, z0, x1, z1] });
    }
  }

  private kitMat(map: THREE.Texture): THREE.MeshStandardMaterial {
    let m = this.kitMats.get(map);
    if (!m) { m = new THREE.MeshStandardMaterial({ map, roughness: 0.88, metalness: 0 }); this.kitMats.set(map, m); }
    return m;
  }

  private glassMat(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color: 0x8fb4d8, emissive: 0xffc46b, emissiveIntensity: 0, roughness: 0.3, metalness: 0.1 });
  }

  /** A single model, recentred on its footprint and scaled to `width` (or by `scale`). */
  private placeModel(m: Model, x: number, z: number, opts: { width?: number; scale?: number; facing?: number; height?: number }): THREE.Group {
    const grp = new THREE.Group();
    const inner = new THREE.Group();
    inner.position.set(-(m.min.x + m.size.x / 2), 0, -(m.min.z + m.size.z / 2));
    grp.add(inner);
    const body = new THREE.Mesh(variant(m, m.body, { snow: this.snow }), this.kitMat(m.map));
    body.castShadow = body.receiveShadow = true;
    inner.add(body);
    if (m.glass) inner.add(new THREE.Mesh(m.glass, this.kitMat(m.map)));
    const s = opts.scale ?? (opts.width ?? 1) / Math.max(m.size.x, m.size.z);
    grp.scale.set(s, opts.height ? opts.height / m.size.y : s, s);
    grp.rotation.y = opts.facing ?? 0;
    grp.position.set(x, 0, z);
    return grp;
  }

  // ---------- build ----------
  setSnow(snow: boolean): void {
    if (snow === this.snow && this.root.children.length) return;
    this.snow = snow;
    if (this.models.size) this.build();
  }

  build(): void {
    for (const c of [...this.root.children]) this.root.remove(c);
    for (const c of [...this.outlines.children]) this.outlines.remove(c);
    for (const c of [...this.fx.children]) this.fx.remove(c);
    this.matLights = []; this.plates.clear(); this.feeders.clear(); this.chimneys = []; this.feederPoles = [];
    this.puffs = []; this.bubbles = []; this.cars = []; this.carMeshes = []; this.walkers = []; this.pickables = []; this.ringMats = []; this.targetFrames = [];
    const snow = this.snow, geo = this.geo;

    // the floor: painted from tract density, land use and every street
    this.textures?.ground.dispose();
    this.textures?.lights.dispose();
    this.textures?.detail.dispose();
    this.textures = paintGround({
      w: WORLD.w, h: WORLD.h, tracts: geo.tracts, landuse: geo.landuse, lakes: geo.lakes, rivers: geo.rivers, creeks: geo.creeks,
      interstates: geo.interstates, highways: geo.highways, streets: this.streetPos, buildings: this.buildingData,
    }, snow, this.renderer.capabilities.getMaxAnisotropy());

    // every real building (made once; snow only changes their roofs)
    if (!this.homes) {
      this.homes = new BuildingsLayer(this.buildingData, WORLD, CIRCUITS.map((c) => c.center), snow);
      this.scene.add(this.homes.group);
      this.plateReach = this.homes.reach;
    }
    this.homes.uniforms.uSnow.value = snow ? 1 : 0;
    CIRCUITS.forEach((c, k) => { if (!this.on[c.id]) this.homes!.setLit(k, false, -10); });

    // the county as a slab in its real shape
    const slabMats = [new THREE.MeshStandardMaterial({ color: snow ? 0xe6ecf2 : 0xa3c27a }), new THREE.MeshStandardMaterial({ color: snow ? 0x6f7b8a : 0x5f744b })];
    for (const poly of geo.county) {
      const g = new THREE.ExtrudeGeometry(shapeOf(poly), { depth: 1.0, bevelEnabled: false, curveSegments: 1 });
      const m = new THREE.Mesh(g, slabMats);
      m.rotation.x = -Math.PI / 2;
      m.position.y = -1.0;
      m.receiveShadow = true;
      this.root.add(m);
    }
    const flat = (g: THREE.BufferGeometry, mat: THREE.Material, y: number) => {
      const m = new THREE.Mesh(g, mat);
      m.position.y = y;
      m.receiveShadow = true;
      this.root.add(m);
      return m;
    };
    const shapes = (polys: Ring[][]) => {
      const g = new THREE.ShapeGeometry(polys.map(shapeOf), 1);
      g.rotateX(-Math.PI / 2);
      return g;
    };
    // one plate per neighborhood (its real census tracts), sharing the painted floor and its night lights
    const tex = this.textures;
    CIRCUITS.forEach((c, k) => {
      const g = shapes(geo.plates[c.id] ?? []);
      worldUV(g, WORLD.w, WORLD.h);
      const mat = new THREE.MeshLambertMaterial({ map: tex.ground, emissiveMap: tex.lights, emissive: 0xffffff, emissiveIntensity: 0 });
      this.detailU.map.value = tex.detail;
      this.plateU.set(c.id, platePatch(mat, c.center, (this.plateReach[k] || 6) * 1.1, this.timeU, !this.on[c.id], this.detailU));
      flat(g, mat, 0.004);
      this.plates.set(c.id, mat);
      this.tops.set(c.id, c.towers ? 0.5 : 0.06);
    });

    // water and roads
    const lakeMat = new THREE.MeshStandardMaterial({ color: snow ? 0xb3c8da : 0x4f8fc4, roughness: snow ? 0.4 : 0.12, metalness: 0.1 });
    flat(shapes(geo.lakes), lakeMat, 0.02);
    flat(ribbons(geo.rivers, 0.08), lakeMat, 0.019);
    // freeways glow with traffic and streetlights at night (see applyLight)
    this.roadMats = [
      new THREE.MeshStandardMaterial({ color: snow ? 0x86909c : 0x5f666f, roughness: 0.85, emissive: 0xffc27a, emissiveIntensity: 0 }),
      new THREE.MeshStandardMaterial({ color: snow ? 0x6a737f : 0x474e58, roughness: 0.8, emissive: 0xffd49a, emissiveIntensity: 0 }),
    ];
    // real widths: arterials ~25 m, freeways with their frontage roads ~45 m
    flat(ribbons(geo.highways, 0.026), this.roadMats[0], 0.009);
    flat(ribbons(geo.interstates, 0.046), this.roadMats[1], 0.011);
    flat(ribbons(geo.interstates, 0.0016, [0.012, 0.016]), new THREE.MeshStandardMaterial({ color: snow ? 0xc8d0da : 0xe8e2c4, roughness: 0.6 }), 0.0125);
    this.buildStreets();

    // No house chimneys: from a playing distance their puffs read as stray floating bubbles over the map (most of
    // all in daylight, during Get ready). Only the power plant's stacks steam (buildInfrastructure).

    this.buildDowntown();
    this.buildLandmarks();
    for (const b of BUILDINGS) this.addCritical(b);
    this.buildInfrastructure();
    this.buildFeeders();
    this.buildCars();
    this.buildLamps();
    this.redrawOutlines();
    this.applyLight();
    this.shadowKey = '';
  }

  /** Every local street as real geometry (crisp up close), split by neighborhood so it goes dark with it. */
  private buildStreets(): void {
    const st = this.streetPos, tex = this.textures!;
    const by = CIRCUITS.map(() => [] as Ring[]);
    for (let i = 0; i < st.length; i += 6) {
      const id = this.circuitAt((st[i] + st[i + 3]) / 2, (st[i + 2] + st[i + 5]) / 2);
      if (id) by[CIRCUIT_INDEX[id]].push([[st[i], st[i + 2]], [st[i + 3], st[i + 5]]]);
    }
    this.streetMats = [];
    // concrete sidewalks along every street (Dallas streets have them on both sides)
    const walk = new THREE.Mesh(ribbons(by.flat(), 0.0172), new THREE.MeshLambertMaterial({ color: this.snow ? 0xdde3ea : 0xc3c0b8 }));
    walk.position.y = 0.0052;
    walk.receiveShadow = true;
    this.root.add(walk);
    this.sidewalks = walk;
    CIRCUITS.forEach((c, k) => {
      const g = ribbons(by[k], 0.0115);
      worldUV(g, WORLD.w, WORLD.h);
      const mat = new THREE.MeshLambertMaterial({ color: this.snow ? 0xa9b2bd : 0x7d8389, emissiveMap: tex.lights, emissive: 0xffffff, emissiveIntensity: 0 });
      this.streetU.set(c.id, platePatch(mat, c.center, (this.plateReach[k] || 6) * 1.1, this.timeU, !this.on[c.id]));
      const m = new THREE.Mesh(g, mat);
      m.position.y = 0.006;
      m.receiveShadow = true;
      m.userData.street = true;
      this.root.add(m);
      this.streetMats.push(mat);
    });
  }

  private buildLandmarks(): void {
    const on = this.on['C-01'] ? 1 : 0;
    // Bank of America Plaza: green argon lines on every edge of the real tower
    {
      // find the real tower by name (OpenStreetMap), so the trim sits exactly on it
      const named = this.buildingData.index.named.find((b) => b.name === 'Bank of America Plaza');
      const at = named ? [named.x, named.z] : BOFA;
      const found = this.homes?.outlineNear(at[0], at[1], 0.03);
      const ring = found?.ring ?? [[-0.03, -0.03], [0.03, -0.03], [0.03, 0.03], [-0.03, 0.03]].map(([dx, dz]) => [BOFA[0] + dx, BOFA[1] + dz] as [number, number]);
      const h = found?.top ?? m2u(281);
      const neon = new THREE.MeshStandardMaterial({ color: 0x0c1a10, emissive: 0x3dff70, emissiveIntensity: 0 });
      const e = 0.0016, parts: THREE.BufferGeometry[] = [];
      ring.forEach(([x, z], i) => {
        const [nx, nz] = ring[(i + 1) % ring.length];
        parts.push(new THREE.BoxGeometry(e, h, e).translate(x, h / 2, z));
        const len = Math.hypot(nx - x, nz - z);
        parts.push(new THREE.BoxGeometry(len + e, e, e).rotateY(-Math.atan2(nz - z, nx - x)).translate((x + nx) / 2, h + e / 2, (z + nz) / 2));
      });
      for (const g of parts) this.root.add(new THREE.Mesh(g, neon));
      this.matLights.push({ circuit: 'C-01', mat: neon, k: 0.9, from: on, to: on, t0: 0 });
      this.tops.set('C-01', Math.max(this.tops.get('C-01') ?? 0, h + 0.03));
    }
    // Dallas Hall at SMU: a white rotunda dome and lantern on the real hall, a columned porch to the south
    {
      const found = this.homes?.outlineNear(DALLAS_HALL[0], DALLAS_HALL[1], 0.03);
      const ring = found?.ring;
      const top = found?.top ?? m2u(16);
      const cx = ring ? ring.reduce((s, p) => s + p[0], 0) / ring.length : DALLAS_HALL[0];
      const cz = ring ? ring.reduce((s, p) => s + p[1], 0) / ring.length : DALLAS_HALL[1];
      const white = new THREE.MeshStandardMaterial({ color: 0xf3f1ea, roughness: 0.55 });
      const r = 0.0105, grp = new THREE.Group();
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.006, 24), white);
      drum.position.y = top + 0.003;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), white);
      dome.position.y = top + 0.006;
      dome.scale.y = 1.15;
      const lantern = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.22, r * 0.25, r * 0.6, 10), white);
      lantern.position.y = top + 0.006 + r * 1.2;
      for (const m of [drum, dome, lantern]) { m.castShadow = true; grp.add(m); }
      // the porch faces Bishop Boulevard, due south
      for (let i = 0; i < 6; i++) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.0009, 0.0009, top * 0.92, 8), white);
        col.position.set((i - 2.5) * 0.0045, top * 0.46, (found ? Math.max(...ring!.map((p) => p[1])) - cz : 0.02) + 0.003);
        col.castShadow = true;
        grp.add(col);
      }
      const pediment = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.0025, 0.007), white);
      pediment.position.set(0, top * 0.93, (found ? Math.max(...ring!.map((p) => p[1])) - cz : 0.02) + 0.003);
      grp.add(pediment);
      grp.position.set(cx, 0, cz);
      this.root.add(grp);
    }
    // Margaret Hunt Hill Bridge: one white arch over a deck across the Trinity
    {
      const [mx, mz] = BRIDGE;
      let best = Infinity, dir: [number, number] = [1, 0], at: [number, number] = [mx, mz];
      for (const line of this.geo.rivers) for (let i = 0; i < line.length - 1; i++) {
        const [ax, az] = line[i], [bx, bz] = line[i + 1];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((mx - ax) * dx + (mz - az) * dz) / l2));
        const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(mx - px, mz - pz);
        if (d < best) { best = d; at = [px, pz]; const l = Math.sqrt(l2); dir = [-dz / l, dx / l]; } // across the river
      }
      const len = 0.42, grp = new THREE.Group();
      const white = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.5, emissive: 0xdfe8ff, emissiveIntensity: 0 });
      const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 0.004, 0.032), new THREE.MeshStandardMaterial({ color: this.snow ? 0xc9d0d8 : 0x8d949c }));
      deck.position.y = 0.016;
      deck.castShadow = deck.receiveShadow = true;
      grp.add(deck);
      const arcPts: THREE.Vector3[] = [];
      for (let i = 0; i <= 32; i++) { const t = i / 32; arcPts.push(new THREE.Vector3((t - 0.5) * len * 0.92, 0.018 + Math.sin(Math.PI * t) * m2u(122), 0)); }
      const arch = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arcPts), 48, 0.0032, 6), white);
      arch.castShadow = true;
      grp.add(arch);
      const cables: THREE.Vector3[] = [];
      for (let i = 3; i <= 29; i += 2) for (const side of [-1, 1]) cables.push(arcPts[i].clone(), new THREE.Vector3(arcPts[i].x, 0.018, side * 0.014));
      grp.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(cables), new THREE.LineBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.8 })));
      grp.position.set(at[0], 0, at[1]);
      grp.rotation.y = Math.atan2(-dir[1], dir[0]);
      this.root.add(grp);
      this.bridgeMat = white;
    }
    // Fair Park: the Texas Star Ferris wheel (turns slowly, lit at night) and the Cotton Bowl
    {
      const [x, z] = TEXAS_STAR, r = m2u(65) / 2.4;
      const stand = new THREE.Group();
      const steel = new THREE.MeshStandardMaterial({ color: 0x8793a3, roughness: 0.5, metalness: 0.3 });
      for (const side of [-1, 1]) for (const lean of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.025, r * 0.04, r * 1.25, 6), steel);
        leg.position.set(lean * r * 0.28, r * 0.6, side * r * 0.14);
        leg.rotation.z = -lean * 0.42;
        stand.add(leg);
      }
      const wheel = new THREE.Group();
      wheel.add(new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.028, 6, 48), steel));
      for (let i = 0; i < 8; i++) {
        const spoke = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.012, r * 0.012, r * 2, 4), steel);
        spoke.rotation.z = (i * Math.PI) / 8;
        wheel.add(spoke);
      }
      const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(r * 0.055, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }), 24);
      const m = new THREE.Matrix4(), col = new THREE.Color();
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        bulbs.setMatrixAt(i, m.makeTranslation(Math.cos(a) * r, Math.sin(a) * r, 0));
        bulbs.setColorAt(i, col.setHSL(i / 24, 0.9, 0.6));
      }
      wheel.add(bulbs);
      wheel.position.y = r * 1.28;
      stand.add(wheel);
      stand.position.set(x, 0, z);
      stand.rotation.y = 0.6;
      this.root.add(stand);
      this.wheel = wheel;
      this.wheelLights = bulbs;
      this.starCircuit = this.circuitAt(x, z) ?? 'C-06';
      const [cx, cz] = COTTON_BOWL;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.125, m2u(30), 40, 1, true).translate(0, m2u(15), 0), new THREE.MeshStandardMaterial({ color: 0xb9b2a6, side: THREE.DoubleSide, roughness: 0.8 }));
      bowl.position.set(cx, 0, cz);
      bowl.castShadow = bowl.receiveShadow = true;
      this.root.add(bowl);
      const field = new THREE.Mesh(new THREE.CircleGeometry(0.12, 32).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: this.snow ? 0xeef2f6 : 0x5f9a4a }));
      field.position.set(cx, 0.008, cz);
      field.scale.set(1, 1, 0.62);
      this.root.add(field);
    }
  }

  /** Reunion Tower: three legs and the lit ball, 171 m. Downtown's towers are the real buildings. */
  private buildDowntown(): void {
    const on = this.on['C-01'] ? 1 : 0;
    const rt = new THREE.Group();
    const conc = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.7 });
    const top = m2u(171), ballR = 0.017;
    for (const [dx, dz] of [[0, -0.0035], [0.004, 0.003], [-0.004, 0.003], [0, 0]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0055, top, 10), conc);
      leg.position.set(dx, top / 2, dz);
      leg.castShadow = true;
      rt.add(leg);
    }
    const ballMat = new THREE.MeshStandardMaterial({ color: 0xe8edf3, emissive: 0xffe2b0, emissiveIntensity: 0, roughness: 0.4 });
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(ballR, 2), ballMat);
    ball.position.y = top;
    ball.castShadow = true;
    rt.add(ball);
    const cage = new THREE.Mesh(new THREE.IcosahedronGeometry(ballR * 1.05, 2), new THREE.MeshBasicMaterial({ color: 0x7c8a9c, wireframe: true, transparent: true, opacity: 0.6 }));
    cage.position.y = top;
    rt.add(cage);
    rt.position.set(REUNION[0], 0, REUNION[1]);
    rt.userData.pick = { kind: 'circuit', id: 'C-01' } satisfies Pick;
    this.root.add(rt);
    this.pickables.push(rt);
    this.matLights.push({ circuit: 'C-01', mat: ballMat, k: 1.2, from: on, to: on, t0: 0 });
  }

  private addCritical(b: BuildingInfo): void {
    const [x, z] = b.at;
    const [w, H] = CRIT[b.kind], d = w;
    const grp = new THREE.Group();
    const glass = this.glassMat();
    const on = this.bOn[b.id] ? 1 : 0;
    this.matLights.push({ circuit: b.circuit, building: b.id, mat: glass, k: 1, from: on, to: on, t0: 0 });
    const block = (bw: number, bh: number, bd: number, color: number, bands: number[], px = 0, pz = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
      mesh.position.set(px, bh / 2, pz);
      mesh.castShadow = mesh.receiveShadow = true;
      grp.add(mesh);
      for (const y of bands) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(bw * 1.01, bh * 0.08, bd * 1.01), glass);
        band.position.set(px, y, pz);
        grp.add(band);
      }
      if (this.snow) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(bw * 1.02, 0.003, bd * 1.02), new THREE.MeshStandardMaterial({ color: 0xf2f6fa }));
        cap.position.set(px, bh + 0.0015, pz);
        grp.add(cap);
      }
    };
    if (b.kind === 'hospital') {
      block(w * 0.8, H, d * 0.8, 0xf3f5f8, [H * 0.3, H * 0.55, H * 0.8]);
      block(w * 0.35, H * 0.35, w * 0.3, 0xdfe5ec, [], 0, d * 0.4 + w * 0.12);
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.6, w * 0.6), new THREE.MeshBasicMaterial({ map: this.padTex, transparent: true }));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(0, H + 0.002, 0);
      grp.add(pad);
      const cross = new THREE.Mesh(new THREE.BoxGeometry(w * 0.03, w * 0.16, w * 0.16), new THREE.MeshBasicMaterial({ color: 0xe0453a }));
      cross.position.set(w * 0.4 + w * 0.015, H * 0.75, 0);
      grp.add(cross);
    } else if (b.kind === 'clinic') {
      block(w * 0.85, H, d * 0.85, 0xeef2f6, [H * 0.55]);
    } else if (b.kind === 'water') {
      block(w * 0.55, H, d * 0.45, 0xd9e0e8, [H * 0.55], -w * 0.18, -d * 0.2);
      const tank = this.models.get('industrial/detail-tank-large')!;
      for (const [tx, tz] of [[w * 0.18, d * 0.15], [-w * 0.15, d * 0.28]]) grp.add(this.placeModel(tank, tx, tz, { width: w * 0.42 }));
    } else if (b.kind === 'gas') {
      block(w * 0.7, H, d * 0.6, 0x9aa3ae, [H * 0.5]);
      grp.add(this.placeModel(this.models.get('industrial/chimney-small')!, -w * 0.25, -d * 0.2, { width: w * 0.35 }));
    } else {
      // a low brick school: main hall, a classroom wing, white trim, a flagpole
      block(w * 0.62, H * 0.62, d * 0.3, 0xa94f3a, [H * 0.36], 0, -d * 0.08);
      block(w * 0.22, H * 0.5, d * 0.52, 0xb45c45, [H * 0.3], w * 0.26, d * 0.18);
      block(w * 0.24, H * 0.85, d * 0.26, 0x9c4a37, [], -w * 0.24, d * 0.15);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(w * 0.64, 0.002, d * 0.32), new THREE.MeshStandardMaterial({ color: 0xf2efe8 }));
      trim.position.set(0, H * 0.62 + 0.001, -d * 0.08);
      grp.add(trim);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.0007, 0.0007, H * 1.4, 5), new THREE.MeshStandardMaterial({ color: 0xdfe3e8 }));
      pole.position.set(-w * 0.05, H * 0.7, d * 0.32);
      grp.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.007), new THREE.MeshStandardMaterial({ color: 0xb8323a, side: THREE.DoubleSide }));
      flag.position.set(-w * 0.05 + 0.0062, H * 1.3, d * 0.32);
      grp.add(flag);
    }
    grp.position.set(x, 0, z);
    grp.userData.pick = { kind: 'building', id: b.id, circuit: b.circuit } satisfies Pick;
    this.root.add(grp);
    this.pickables.unshift(grp);
    this.tops.set(b.id, H + 0.02);
    const r = w * 0.8;
    // drawn over the ground and nearby buildings, so the ring (protected, at risk, generator target) stays visible
    // when the detailed ground and houses load in at street zoom
    const mat = new THREE.MeshBasicMaterial({ color: ICE, transparent: true, opacity: 0, depthWrite: false, depthTest: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + w * 0.08, 48), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.012, z);
    ring.renderOrder = 10;
    this.fx.add(ring);
    const gen = new THREE.Mesh(new THREE.BoxGeometry(w * 0.16, w * 0.11, w * 0.11), new THREE.MeshStandardMaterial({ color: GEN, emissive: 0x5a4300 }));
    gen.position.set(x + w * 0.62, w * 0.055, z);
    gen.visible = false;
    this.root.add(gen);
    this.ringMats.push({ building: b.id, mat, gen });
  }

  private buildInfrastructure(): void {
    // Mountain Creek gas power plant with its stacks
    const [px, pz] = POWER_PLANT;
    this.root.add(this.placeModel(this.models.get('industrial/building-a')!, px, pz, { width: 0.3 }));
    const stack = this.models.get('industrial/chimney-large')!;
    const ss = m2u(80) / stack.size.y;
    for (const [dx, dz] of [[-0.09, -0.13], [0.06, -0.14]]) {
      this.root.add(this.placeModel(stack, px + dx, pz + dz, { scale: ss }));
      this.chimneys.push({ p: new THREE.Vector3(px + dx, stack.size.y * ss + 0.01, pz + dz), circuit: -1, next: Math.random() * 500, big: true });
    }
    const wt = this.models.get('industrial/water-tower')!;
    this.root.add(this.placeModel(wt, WATER_TOWER[0], WATER_TOWER[1], { scale: m2u(45) / wt.size.y }));
    // the substation every feeder starts from
    const [hx, hz] = HUB;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.004, 0.16), new THREE.MeshStandardMaterial({ color: this.snow ? 0x9aa4b0 : 0x8c949e }));
    pad.position.set(hx, 0.002, hz);
    this.root.add(pad);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xb9c1cb, roughness: 0.6, metalness: 0.3 });
    for (const [dx, dz] of [[-0.04, -0.04], [0.04, -0.04], [-0.04, 0.04], [0.04, 0.04]]) {
      const bx = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.014, 0.045), boxMat);
      bx.position.set(hx + dx, 0.009, hz + dz);
      bx.castShadow = true;
      this.root.add(bx);
    }
  }

  private buildFeeders(): void {
    const [sx, sz] = HUB;
    const a = new THREE.Vector3(sx, 0.2, sz);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x6b5a48 });
    for (const c of CIRCUITS) {
      const [px, pz] = c.center;
      const b = new THREE.Vector3(px, 0.3, pz);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.3, 6), poleMat);
      pole.position.set(px, 0.15, pz);
      this.root.add(pole);
      this.feederPoles.push(pole);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y += 0.4 + a.distanceTo(b) * 0.035;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const mat = new THREE.LineBasicMaterial({ color: 0x2b3340, transparent: true, opacity: 0.4 });
      this.root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), mat));
      this.feeders.set(c.id, { curve, mat });
    }
    this.flow = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0x9fd6ff }), CIRCUITS.length * 4);
    this.flow.frustumCulled = false;
    this.root.add(this.flow);
  }

  /** Traffic on the real interstates, instanced per car model, with headlights as glow points. */
  private buildCars(): void {
    const paths: CarPath[] = this.geo.carPaths.map((pts) => {
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      return { pts, cum, len: cum[cum.length - 1] };
    });
    const plan: { path: CarPath; s: number; dir: 1 | -1; speed: number; kind: number }[] = [];
    let k = 0;
    for (const path of paths) {
      const n = Math.max(4, Math.round(path.len / 0.7));
      for (let i = 0; i < n; i++, k++) plan.push({ path, s: (path.len * (i + Math.random() * 0.6)) / n, dir: k % 2 ? 1 : -1, speed: 0.05 + (k % 3) * 0.012, kind: k % CARS.length });
    }
    CARS.forEach((name, kind) => {
      const m = this.models.get(`cars/${name}`)!;
      const mine = plan.filter((p) => p.kind === kind);
      const mesh = new THREE.InstancedMesh(m.body, this.kitMat(m.map), Math.max(1, mine.length));
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      this.root.add(mesh);
      this.carMeshes.push(mesh);
      const centre = new THREE.Matrix4().makeTranslation(-(m.min.x + m.size.x / 2), 0, -(m.min.z + m.size.z / 2));
      const scale = 0.0068 / Math.max(m.size.x, m.size.z); // ~6.5 m long
      mine.forEach((p, idx) => this.cars.push({ path: p.path, s: p.s, dir: p.dir, speed: p.speed, mesh, idx, centre, scale }));
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.cars.length * 3), 3));
    this.headlights = new THREE.Points(g, new THREE.PointsMaterial({
      map: this.glowTex, color: 0xfff1c9, size: 10, sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
    }));
    this.headlights.frustumCulled = false;
    this.fx.add(this.headlights);
  }

  private buildLamps(): void {
    const n = LAMPS.length;
    this.lampBulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0022, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    this.lampPools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      map: this.glowTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    LAMPS.forEach((l, i) => {
      this.lampBulbs.setMatrixAt(i, m.compose(new THREE.Vector3(l.x, 0.016, l.z), q, new THREE.Vector3(1, 1, 1)));
      this.lampBulbs.setColorAt(i, this.tmpColor.setRGB(0.3, 0.28, 0.25));
      this.lampPools.setMatrixAt(i, m.compose(new THREE.Vector3(l.x, 0.013, l.z), q, new THREE.Vector3(0.07, 1, 0.07)));
      this.lampPools.setColorAt(i, this.tmpColor.setRGB(0, 0, 0));
    });
    this.lampBulbs.frustumCulled = this.lampPools.frustumCulled = false;
    this.root.add(this.lampBulbs);
    this.fx.add(this.lampPools);
  }

  // ---------- state ----------
  setState(s: GameState): void {
    const now = this.t;
    for (const c of s.circuits) {
      const id = c.parent ?? c.id;
      if (this.on[id] !== c.on) {
        this.on[id] = c.on;
        const k = CIRCUIT_INDEX[id];
        if (k != null) this.homes?.setLit(k, c.on, now / 1000);
        for (const pu of [this.plateU.get(id), this.streetU.get(id)]) {
          if (pu) { pu.uFrom.value = plateLit(pu, now / 1000, 0.5); pu.uTo.value = c.on ? 1 : 0; pu.uT0.value = now / 1000; }
        }
        for (const l of this.matLights) if (!l.building && l.circuit === id) this.startLit(l, c.on, now);
      }
    }
    for (const b of s.buildings) {
      if (this.bOn[b.id] !== b.on) {
        this.bOn[b.id] = b.on;
        for (const l of this.matLights) if (l.building === b.id) this.startLit(l, b.on, now);
      }
    }
    this.state = s;
    for (const c of CIRCUITS) {
      const plate = this.plates.get(c.id);
      if (plate) plate.color.setScalar(this.on[c.id] ? 1 : this.snow ? 0.8 : 0.85);
    }
    this.refreshFeederColors();
    for (const r of this.ringMats) r.gen.visible = !!s.buildings.find((x) => x.id === r.building)?.generator;
    this.redrawOutlines();
  }

  private refreshFeederColors(): void {
    for (const [id, f] of this.feeders) {
      const prot = this.circuitState(id)?.protected;
      f.mat.color.set(prot ? ICE : this.on[id] ? (this.night > 0.5 ? 0x9fb4cc : 0x2b3340) : 0x77808c);
      f.mat.userData.base = this.on[id] ? 0.45 : 0.2;
    }
  }

  private startLit(l: Lit, on: boolean, now: number): void {
    l.from = litAt(l, now);
    l.to = on ? 1 : 0;
    l.t0 = now + Math.random() * 600;
  }

  setUI(ui: SceneUI): void {
    this.ui = ui;
    this.redrawOutlines();
  }

  private circuitState(id: string) { return this.state?.circuits.find((c) => c.id === id); }

  /** Outline ribbon `px` screen pixels wide at the current zoom. */
  private outline(id: string, color: number, px: number, dashPx?: [number, number], opacity = 1): THREE.Mesh {
    const u = this.outlineUnit * 1.25;
    const m = new THREE.Mesh(
      ribbons(this.geo.outlines[id] ?? [], px * u, dashPx ? [dashPx[0] * u, dashPx[1] * u] : undefined),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
    );
    m.position.y = 0.07;
    m.renderOrder = 3; // drawn over houses and trees so a selection never breaks up
    this.outlines.add(m);
    return m;
  }

  private redrawOutlines(): void {
    if (!this.geo) return;
    this.outlineUnit = this.rig.unitsPerPx;
    for (const c of [...this.outlines.children]) { this.outlines.remove(c); (c as THREE.Mesh).geometry.dispose(); }
    this.targetFrames = [];
    const ICE = this.night < 0.5 ? ICE_DAY : ICE_NIGHT; // light ice vanishes on daylit ground
    if (this.ui.selected && CIRCUIT_BY_ID[this.ui.selected]) this.outline(this.ui.selected, ICE, 6, undefined, 0.55);
    for (const c of CIRCUITS) {
      const cs = this.circuitState(c.id);
      if (cs?.protected) this.outline(c.id, ICE, 3, [10, 7], 0.95);
      if (cs && !cs.on && cs.indoor_f < 50) this.outline(c.id, COLD, 3.5, [12, 7]);
      if (this.ui.targets === 'circuits') this.targetFrames.push(this.outline(c.id, ICE, 2, [7, 6], 0.8));
    }
    const hv = this.ui.hover;
    if (hv) {
      const id = hv.kind === 'circuit' ? hv.id : hv.circuit;
      const cutting = this.ui.tool === 'cut' && this.on[id];
      this.outline(id, cutting ? AMBER : ICE, 3, cutting ? [8, 5] : undefined, 0.95);
    }
    for (const [id, until] of Object.entries(this.flashes)) if (until > this.t) this.outline(id, AMBER, 4).name = `flash-${id}`;
  }

  // ---------- picking ----------
  private ndc = new THREE.Vector2();
  pick(px: number, py: number): Pick | null {
    this.ndc.set((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.rig.camera);
    const hits = this.ray.intersectObjects(this.pickables, true);
    for (const hit of hits) {
      const inst = (hit.object.userData.picks as Pick[] | undefined)?.[hit.instanceId ?? -1];
      if (inst) return inst;
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.pick) o = o.parent;
      if (o) return o.userData.pick as Pick;
    }
    const g = this.rig.groundAt(px, py);
    if (!g) return null;
    const id = this.circuitAt(g.x, g.z);
    return id ? { kind: 'circuit', id } : null;
  }

  circuitAt(x: number, z: number): string | null {
    for (const [id, { rings, box }] of this.plateRings) {
      if (x < box[0] || x > box[2] || z < box[1] || z > box[3]) continue;
      for (const poly of rings) if (pointInRing(x, z, poly[0]) && !poly.slice(1).some((h) => pointInRing(x, z, h))) return id;
    }
    return null;
  }

  // ---------- light and weather ----------
  setDaylight(night: number, golden = 0): void {
    const n = Math.max(0, Math.min(1, night));
    if (Math.abs(n - this.night) < 0.01 && Math.abs(golden - this.golden) < 0.02) return;
    const flip = n >= 0.5 !== this.night >= 0.5;
    this.night = n;
    this.golden = golden;
    this.applyLight();
    if (flip) this.redrawOutlines();
  }

  get nightLevel(): number { return this.night; }

  private applyLight(): void {
    const n = this.night, snow = this.snow;
    const lerp = (a: number, b: number) => new THREE.Color(a).lerp(new THREE.Color(b), n);
    const sky = lerp(snow ? 0xc0ccd8 : 0xd8e3ec, 0x2a3650);
    (this.backdrop.material as THREE.MeshBasicMaterial).color.copy(sky);
    this.scene.background = sky.clone().multiplyScalar(0.42);
    this.hemi.color = lerp(snow ? 0xe6eef7 : 0xf3f8ff, 0x4d6496);
    this.hemi.groundColor = lerp(snow ? 0x9aa6b5 : 0x8a9a6a, 0x121828);
    // clear days: a strong low sun and a soft sky, so buildings cast readable shadows; the storm is overcast,
    // so its light is flatter (softer shadows, brighter sky)
    this.hemi.intensity = THREE.MathUtils.lerp(snow ? 1.0 : 0.62, 0.75, n);
    this.sun.color = lerp(snow ? 0xf2f5fa : 0xfff3df, 0x9db4e0);
    this.sun.intensity = THREE.MathUtils.lerp(snow ? 2.1 : 3.4, 0.45, n);
    // sunrise and sunset: a low warm light through the storm clouds
    const g = this.golden * (snow ? 0.7 : 1);
    if (g > 0.01) {
      this.sun.color.lerp(new THREE.Color(0xffa36b), g * 0.6);
      this.hemi.color.lerp(new THREE.Color(0xf0c0a8), g * 0.28);
      sky.lerp(new THREE.Color(0xc98a8a), g * 0.3);
      (this.backdrop.material as THREE.MeshBasicMaterial).color.copy(sky);
      this.scene.background = sky.clone().multiplyScalar(0.42);
    }
    this.bloom.strength = 0.08 + 0.48 * n;
    if (this.roadMats.length) { this.roadMats[0].emissiveIntensity = 0.12 * n; this.roadMats[1].emissiveIntensity = 0.17 * n; }
    const glassDay = new THREE.Color(0x8fb4d8), glassNight = new THREE.Color(0x1b2330);
    for (const l of this.matLights) l.mat.color.copy(glassDay).lerp(glassNight, n);
    this.refreshFeederColors();
  }

  /** Ground corners under the screen, padded, for picking which homes get full detail. */
  private viewQuad(): [number, number][] | null {
    const pad = 0.08, out: [number, number][] = [];
    for (const [sx, sy] of [[-pad, -pad], [1 + pad, -pad], [1 + pad, 1 + pad], [-pad, 1 + pad]]) {
      const g = this.rig.groundAt(sx * this.w, sy * this.h);
      if (!g) return null;
      out.push([Math.round(g.x * 4) / 4, Math.round(g.z * 4) / 4]);
    }
    return out;
  }

  /** The sun's shadow box follows the view, so close-ups get sharp shadows. */
  private fitShadow(): void {
    const half = Math.min(42, Math.max(0.06, this.rig.unitsPerPx * Math.max(this.w, this.h) * 0.85));
    const step = (half * 2) / 512;
    const tx = Math.round(this.rig.target.x / step) * step, tz = Math.round(this.rig.target.z / step) * step;
    const key = `${tx}|${tz}|${half.toFixed(2)}`;
    if (key === this.shadowKey) return;
    this.shadowKey = key;
    this.renderer.shadowMap.needsUpdate = true;
    // the light's depth range hugs the view, and the bias is a fixed share of a shadow texel: real buildings
    // are only metres tall in map units, so a loose range or a large bias would swallow every shadow
    const dist = half * 1.6 + 1;
    const cam = this.sun.shadow.camera;
    Object.assign(cam, { left: -half, right: half, top: half, bottom: -half, near: 0.02, far: dist * 2 });
    cam.updateProjectionMatrix();
    this.sun.target.position.set(tx, 0, tz);
    this.sun.position.set(tx, 0, tz).addScaledVector(SUN_DIR, dist);
    // casters draw their back faces into the map, so almost no bias is needed; anything more than a metre
    // or so would erase the short shadows of real one-story houses
    const texel = (half * 2) / this.sun.shadow.mapSize.x;
    this.sun.shadow.bias = -0.00005 / (dist * 2);
    this.sun.shadow.normalBias = texel * 0.25;
  }

  // ---------- frame ----------
  private tick(dt: number): void {
    this.t += dt;
    const t = this.t, n = this.night, s = dt / 1000, tSec = t / 1000;
    this.rig.update(dt);
    if (!this.homes) { this.composer.render(); return; }
    if (this.outlineUnit && Math.abs(this.rig.unitsPerPx / this.outlineUnit - 1) > 0.18) this.redrawOutlines();
    this.fitShadow();
    if (this.homes.update(tSec, n, this.rig.zoom)) this.shadowKey = '';

    // each neighborhood's streets glow at night and go dark with it. Up close everything eases down, so a
    // street at night looks like a street (lamps, lit windows) and not a lava field.
    const zf = THREE.MathUtils.smoothstep(this.rig.zoom, 1.5, 10);
    this.detailU.k.value = 1 - THREE.MathUtils.smoothstep(this.rig.zoom, 6, 11); // the real 3D streets and houses take over
    GRAIN.value = THREE.MathUtils.smoothstep(this.rig.zoom, 12, 40);
    if (this.sidewalks) this.sidewalks.visible = this.rig.zoom >= 18; // under two pixels wide before that
    const glow = 1.05 * (1 - 0.72 * zf);
    this.homes.uniforms.uBright.value = 2.3 - 1.25 * zf;
    if (!lowQuality) {
      this.bloom.strength = (0.08 + 0.48 * n) * (1 - 0.55 * zf);
      this.bloom.enabled = n > 0.12; // daylight has nothing to glow
    }
    this.timeU.value = tSec;
    CIRCUITS.forEach((c, k) => {
      const plate = this.plates.get(c.id);
      if (plate) plate.emissiveIntensity = n * glow;
      const sm = this.streetMats[k];
      if (sm) sm.emissiveIntensity = n * glow * 1.3;
      // frost creeps in from the edges as homes drop below ~55°F, and melts back when they warm up
      const cs = this.circuitState(c.id);
      const goal = cs ? THREE.MathUtils.clamp((55 - cs.indoor_f) / 14, 0, 1) : 0;
      this.frost[k] += (goal - this.frost[k]) * Math.min(1, s * 4);
      const pu = this.plateU.get(c.id);
      if (pu) { pu.uFrost.value = this.frost[k]; pu.uFrostGlow.value = (0.03 + 0.2 * n) * (0.7 + 0.3 * zf); }
      const su = this.streetU.get(c.id);
      if (su) su.uFrost.value = this.frost[k] * 0.6;
    });
    // the feeder wires explain power flow at county scale; up close they'd just be stray cables
    const feedFade = 1 - THREE.MathUtils.smoothstep(this.rig.zoom, 2.4, 4.2);
    for (const f of this.feeders.values()) { f.mat.opacity = (f.mat.userData.base ?? 0.45) * feedFade; f.mat.visible = feedFade > 0.02; }
    this.flow.visible = feedFade > 0.3;
    for (const p of this.feederPoles) p.visible = feedFade > 0.02;
    for (const l of this.matLights) l.mat.emissiveIntensity = litAt(l, t) * (0.1 + 2.0 * n) * l.k * (1 - 0.45 * zf);

    // the Texas Star turns; it and the bridge light up at night
    if (this.wheel && !reduceMotion) this.wheel.rotation.z += s * 0.08;
    if (this.wheelLights) {
      const wl = this.wheelLights.material as THREE.MeshBasicMaterial;
      const lit = this.on[this.starCircuit] ? 1 : 0;
      wl.color.setScalar(0.7 + (1.3 * n) * lit);
    }
    if (this.bridgeMat) this.bridgeMat.emissiveIntensity = 0.55 * n;

    // power flow dots along powered feeders
    const mtx = new THREE.Matrix4();
    let i = 0;
    for (const ci of CIRCUITS) {
      const f = this.feeders.get(ci.id);
      for (let k = 0; k < 4; k++) {
        if (f && this.on[ci.id] && !reduceMotion) {
          const p = f.curve.getPoint((t / 4200 + k / 4 + ci.center[0] * 0.013) % 1);
          mtx.makeTranslation(p.x, p.y, p.z);
        } else mtx.makeScale(0, 0, 0);
        this.flow.setMatrixAt(i++, mtx);
      }
    }
    this.flow.instanceMatrix.needsUpdate = true;

    // rings: protected (steady ice), at risk (pulsing amber), generator targets (pulsing yellow)
    const pulse = reduceMotion ? 0.8 : 0.5 + 0.4 * Math.sin(t / 240);
    for (const r of this.ringMats) {
      const b = this.state?.buildings.find((x) => x.id === r.building);
      const prot = b?.protected || this.circuitState(b?.circuit ?? '')?.protected;
      const risk = b && (b.at_risk || (!b.on && !b.generator));
      const target = this.ui.targets === 'buildings' && BUILDINGS.find((x) => x.id === r.building)?.kind !== 'school';
      r.mat.color.set(target ? GEN : risk ? AMBER : ICE);
      r.mat.opacity = target || risk ? pulse : prot ? 0.9 : 0;
    }
    for (const f of this.targetFrames) (f.material as THREE.MeshBasicMaterial).opacity = pulse;
    let flashChanged = false;
    for (const [id, until] of Object.entries(this.flashes)) {
      if (until < t) { delete this.flashes[id]; flashChanged = true; continue; }
      if (!this.outlines.getObjectByName(`flash-${id}`)) flashChanged = true;
    }
    if (flashChanged) this.redrawOutlines();

    // smoke from homes with power, steam from the plant
    if (!reduceMotion) {
      for (const ch of this.chimneys) {
        if (ch.circuit >= 0 && !this.on[CIRCUITS[ch.circuit].id]) continue;
        ch.next -= dt;
        if (ch.next > 0 || this.puffs.length >= MAX_PUFFS) continue;
        ch.next = ch.big ? 420 + Math.random() * 260 : 2600 + Math.random() * 3000;
        this.puffs.push({ x: ch.p.x, y: ch.p.y, z: ch.p.z, size: ch.big ? 0.05 : 0.008, life: 0, max: ch.big ? 3400 : 2600, vy: ch.big ? 0.05 : 0.008, grow: ch.big ? 0.06 : 0.009 });
      }
    }
    // all puffs in one draw
    const sg = this.smoke.geometry;
    const sp = sg.getAttribute('position') as THREE.BufferAttribute, ss = sg.getAttribute('aSize') as THREE.BufferAttribute, sa = sg.getAttribute('aAlpha') as THREE.BufferAttribute;
    for (let k = this.puffs.length - 1; k >= 0; k--) {
      const p = this.puffs[k];
      p.life += dt;
      if (p.life >= p.max) { this.puffs.splice(k, 1); continue; }
      p.y += p.vy * s;
      p.x += p.grow * 0.4 * s;
      p.size += p.grow * s;
    }
    this.puffs.forEach((p, k) => {
      const u = p.life / p.max;
      sp.setXYZ(k, p.x, p.y, p.z);
      ss.setX(k, p.size);
      sa.setX(k, (0.55 - 0.25 * n) * (1 - u) * Math.min(1, u * 6));
    });
    sg.setDrawRange(0, this.puffs.length);
    sp.needsUpdate = ss.needsUpdate = sa.needsUpdate = true;
    (this.smoke.material as THREE.ShaderMaterial).uniforms.uScale.value = this.renderer.getPixelRatio() / this.rig.unitsPerPx;

    // traffic: slower in the storm, headlights at night
    const hl = this.headlights?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    const cm = this.tmpM, cq = this.tmpQ, cv = this.tmpV, cs = this.tmpS;
    const carsShown = this.rig.zoom >= 7;
    for (const m of this.carMeshes) m.visible = carsShown;
    this.lampBulbs.visible = this.rig.zoom >= 10;
    if (carsShown || n > 0.05) this.cars.forEach((car, ci) => {
      const { path } = car;
      if (!reduceMotion) car.s = (car.s + car.dir * car.speed * (this.snow ? 0.45 : 1) * s + path.len) % path.len;
      let j = 1;
      while (j < path.cum.length - 1 && path.cum[j] < car.s) j++;
      const a = path.pts[j - 1], b = path.pts[j];
      const seg = path.cum[j] - path.cum[j - 1] || 1;
      const u = (car.s - path.cum[j - 1]) / seg;
      const x = a[0] + (b[0] - a[0]) * u, z = a[1] + (b[1] - a[1]) * u;
      const dx = (b[0] - a[0]) * car.dir, dz = (b[1] - a[1]) * car.dir;
      const len = Math.hypot(dx, dz) || 1;
      const side = 0.009 * car.dir;
      const px = x - (dz / len) * side, pz = z + (dx / len) * side;
      if (carsShown) {
        cm.compose(cv.set(px, 0.0115, pz), cq.setFromAxisAngle(UP, Math.atan2(dx, dz)), cs.setScalar(car.scale)).multiply(car.centre);
        car.mesh.setMatrixAt(car.idx, cm);
      }
      hl?.setXYZ(ci, px + (dx / len) * 0.004, 0.014, pz + (dz / len) * 0.004);
    });
    for (const m of this.carMeshes) m.instanceMatrix.needsUpdate = true;
    if (hl && this.headlights) {
      hl.needsUpdate = true;
      (this.headlights.material as THREE.PointsMaterial).opacity = n * 0.9;
      (this.headlights.material as THREE.PointsMaterial).size = Math.min(14, 2.5 + this.rig.zoom * 0.25);
    }

    // streetlights follow their circuit
    const c = this.tmpColor;
    for (let k = 0; k < LAMPS.length; k++) {
      const lit = this.on[LAMPS[k].circuit] ? n : 0;
      this.lampBulbs.setColorAt(k, c.setRGB(0.3 + 0.9 * lit, 0.28 + 0.75 * lit, 0.25 + 0.45 * lit));
      this.lampPools.setColorAt(k, c.setRGB(1, 0.8, 0.5).multiplyScalar(lit * 0.25 * (1 - 0.4 * zf)));
    }
    if (this.lampBulbs.instanceColor) this.lampBulbs.instanceColor.needsUpdate = true;
    if (this.lampPools.instanceColor) this.lampPools.instanceColor.needsUpdate = true;

    // people walk from dark neighborhoods to the warming center
    const school = BUILDINGS.find((b) => b.kind === 'school')!.at;
    const warming = !!this.state?.prep?.warming_center && this.state?.phase === 'storm';
    if (warming && !reduceMotion) {
      this.walkAcc += dt;
      const dark = CIRCUITS.filter((ci) => !this.on[ci.id] && !ci.towers && Math.hypot(ci.center[0] - school[0], ci.center[1] - school[1]) < 14);
      if (this.walkAcc > 500 && dark.length && this.walkers.length < 60) {
        this.walkAcc = 0;
        const ci = dark[Math.floor(Math.random() * dark.length)];
        const coat = [0xc7473a, 0x3f6fb5, 0xe2b33c, 0x4c8a5a, 0x8a5fb5][Math.floor(Math.random() * 5)];
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.0016, 0.0036, 2, 6), new THREE.MeshStandardMaterial({ color: coat }));
        // set off from the dark neighborhood's edge nearest the school
        const x = ci.center[0] + (school[0] - ci.center[0]) * 0.65 + (Math.random() - 0.5) * 0.8;
        const z = ci.center[1] + (school[1] - ci.center[1]) * 0.65 + (Math.random() - 0.5) * 0.8;
        m.position.set(x, 0.004, z);
        this.root.add(m);
        this.walkers.push({ x, z, node: m, speed: 0.04 + Math.random() * 0.02 });
      }
    }
    for (let k = this.walkers.length - 1; k >= 0; k--) {
      const w = this.walkers[k];
      const dx = school[0] - w.x, dz = school[1] + 0.12 - w.z, dist = Math.hypot(dx, dz);
      if (dist < 0.03 || !warming) { this.root.remove(w.node); this.walkers.splice(k, 1); continue; }
      w.x += (dx / dist) * w.speed * s;
      w.z += (dz / dist) * w.speed * s;
      w.node.position.set(w.x, 0.004 + Math.abs(Math.sin(t / 110 + k)) * 0.0008, w.z);
    }

    // thought bubbles over cold homes, when you're close enough to see the houses
    this.bubbleAcc += dt;
    const cold = this.state?.circuits.filter((ci) => !ci.on && ci.indoor_f < 50) ?? [];
    if (this.rig.zoom >= 3.5 && cold.length && this.bubbleAcc > 700 && this.bubbles.length < 8 && !reduceMotion) {
      this.bubbleAcc = 0;
      const view = this.viewQuad();
      if (view) {
        const xs = view.map((p) => p[0]), zs = view.map((p) => p[1]);
        const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
        const ci = cold[Math.floor(Math.random() * cold.length)];
        const list = this.homes.housesBy[CIRCUIT_INDEX[ci.parent ?? ci.id]] ?? [];
        for (let tries = 0; tries < 80 && list.length; tries++) {
          const at = this.homes.rectAt(list[Math.floor(Math.random() * list.length)]);
          if (at.x < x0 || at.x > x1 || at.z < z0 || at.z > z1) continue;
          const sp = new THREE.Sprite(this.bubbleMat);
          sp.position.set(at.x, at.top * 1.3, at.z);
          sp.center.set(0.2, 0);
          sp.renderOrder = 5;
          this.fx.add(sp);
          this.bubbles.push({ s: sp, age: 0, y0: at.top * 1.3 });
          break;
        }
      }
    }
    for (let k = this.bubbles.length - 1; k >= 0; k--) {
      const b = this.bubbles[k];
      b.age += dt;
      if (b.age > 2900 || this.rig.zoom < 3) { this.fx.remove(b.s); this.bubbles.splice(k, 1); continue; }
      const pop = b.age < 220 ? (b.age / 220) * 1.15 : b.age < 320 ? 1.15 - ((b.age - 220) / 100) * 0.15 : 1;
      const fade = b.age > 2400 ? 1 - (b.age - 2400) / 500 : 1;
      b.s.scale.setScalar(46 * this.rig.unitsPerPx * pop * (0.6 + 0.4 * fade));
      b.s.position.y = b.y0 + (b.age / 2900) * 0.006;
    }

    // falling snow (storm only)
    this.snowfall.points.visible = this.snow && !reduceMotion;
    if (this.snow) {
      this.pan.set((this.rig.target.x - this.rig.target.z) * 0.004, (this.rig.target.x + this.rig.target.z) * 0.002);
      this.snowfall.update(tSec, this.state?.weather?.snow ?? 0.7, this.renderer.getPixelRatio(), this.w / this.h, this.pan);
    }

    this.composer.render();
    for (const fn of this.hooks) fn();
  }

  /** A copy of the current frame, for cross-fades. */
  snapshot(): HTMLCanvasElement {
    this.composer.render();
    const src = this.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
    return c;
  }
}
