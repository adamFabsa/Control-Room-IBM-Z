// Loads the CC0 Kenney kits and prepares them for the game:
// - meshes merged into one geometry per model (nodes named in `keep` stay separate, e.g. turbine blades)
// - window glass triangles split out, so every house can light up or go dark on its own
// - variants by remapping UVs on the shared palette texture: roof colors, and snow on anything facing up
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface Model {
  name: string;
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry | null;
  parts: Record<string, THREE.BufferGeometry>; // kept nodes, in model space, with their pivot at the origin
  pivots: Record<string, THREE.Vector3>;
  size: THREE.Vector3;
  min: THREE.Vector3;
  map: THREE.Texture;
}

// palette swatches: 8 columns × 4 rows; UVs have their origin at the top-left (glTF)
const col = (u: number) => Math.floor(u * 8);
const row = (v: number) => Math.floor(v * 4);
const GREEN = (u: number, v: number) => col(u) === 0 && row(v) === 1;
// the suburban, commercial and car kits share one palette layout; the industrial kit has its own
interface Palette { glass: [number, number]; white: [number, number] }
const PALETTES: Record<string, Palette> = { industrial: { glass: [4, 3], white: [0.89, 0.56] } };
const DEFAULT_PALETTE: Palette = { glass: [5, 1], white: [0.395, 0.56] };
const paletteOf = (url: string) => PALETTES[url.match(/models\/([^/]+)\//)?.[1] ?? ''] ?? DEFAULT_PALETTE;
const isGlass = (p: Palette, u: number, v: number) => col(u) === p.glass[0] && row(v) === p.glass[1];

const loader = new GLTFLoader();
const cache = new Map<string, Promise<Model>>();
const textures = new Map<string, THREE.Texture>();

function slim(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', src.getAttribute('position'));
  if (!src.getAttribute('normal')) src.computeVertexNormals();
  out.setAttribute('normal', src.getAttribute('normal'));
  out.setAttribute('uv', src.getAttribute('uv'));
  return out;
}

function splitGlass(g: THREE.BufferGeometry, pal: Palette): [THREE.BufferGeometry, THREE.BufferGeometry | null] {
  const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = g.getAttribute('uv');
  const body = { p: [] as number[], n: [] as number[], t: [] as number[] };
  const glass = { p: [] as number[], n: [] as number[], t: [] as number[] };
  for (let i = 0; i < pos.count; i += 3) {
    const u = (uv.getX(i) + uv.getX(i + 1) + uv.getX(i + 2)) / 3;
    const v = (uv.getY(i) + uv.getY(i + 1) + uv.getY(i + 2)) / 3;
    const dst = isGlass(pal, u, v) ? glass : body;
    for (let k = i; k < i + 3; k++) {
      dst.p.push(pos.getX(k), pos.getY(k), pos.getZ(k));
      dst.n.push(nor.getX(k), nor.getY(k), nor.getZ(k));
      dst.t.push(uv.getX(k), uv.getY(k));
    }
  }
  const make = (s: typeof body) => {
    const o = new THREE.BufferGeometry();
    o.setAttribute('position', new THREE.Float32BufferAttribute(s.p, 3));
    o.setAttribute('normal', new THREE.Float32BufferAttribute(s.n, 3));
    o.setAttribute('uv', new THREE.Float32BufferAttribute(s.t, 2));
    return o;
  };
  return [make(body), glass.p.length ? make(glass) : null];
}

export function loadModel(url: string, keep: string[] = []): Promise<Model> {
  const key = url + '|' + keep.join(',');
  let p = cache.get(key);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const geos: THREE.BufferGeometry[] = [];
      const parts: Record<string, THREE.BufferGeometry> = {};
      const pivots: Record<string, THREE.Vector3> = {};
      let map: THREE.Texture | null = null;
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
        if (mat?.map) map = mat.map;
        const keptName = keep.find((k) => mesh.name === k || mesh.parent?.name === k);
        if (keptName) {
          const pivot = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
          const g = slim(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)).translate(-pivot.x, -pivot.y, -pivot.z);
          parts[keptName] = g;
          pivots[keptName] = pivot;
        } else {
          geos.push(slim(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)));
        }
      });
      const merged = mergeGeometries(geos)!;
      merged.computeBoundingBox();
      const bb = merged.boundingBox!;
      const [body, glass] = splitGlass(merged, paletteOf(url));
      const tex = sharedTexture(url, map!);
      return { name: url, body, glass, parts, pivots, size: bb.getSize(new THREE.Vector3()), min: bb.min.clone(), map: tex };
    });
    cache.set(key, p);
  }
  return p;
}

/** One texture per kit, with filtering that keeps palette swatches from bleeding. */
function sharedTexture(url: string, map: THREE.Texture): THREE.Texture {
  const kit = url.split('/').slice(0, -1).join('/');
  let t = textures.get(kit);
  if (!t) {
    t = map;
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    textures.set(kit, t);
  }
  return t;
}

export interface VariantOpts {
  roof?: [number, number]; // shift for green roof triangles, in swatches (columns, rows)
  snow?: boolean; // anything facing up turns white
  snowY?: number; // how upward a face must be to hold snow (default 0.5)
}

const variants = new Map<string, THREE.BufferGeometry>();

export function variant(model: Model, geo: THREE.BufferGeometry, opts: VariantOpts, tag = 'body'): THREE.BufferGeometry {
  const key = `${model.name}|${tag}|${opts.roof?.join(',') ?? ''}|${opts.snow ? `s${opts.snowY ?? 0.5}` : ''}`;
  let g = variants.get(key);
  if (g) return g;
  g = geo.clone();
  const pos = g.getAttribute('position'), uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const pal = paletteOf(model.name);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const u = (uv.getX(i) + uv.getX(i + 1) + uv.getX(i + 2)) / 3;
    const v = (uv.getY(i) + uv.getY(i + 1) + uv.getY(i + 2)) / 3;
    if (opts.snow && n.y > (opts.snowY ?? 0.5) && !isGlass(pal, u, v)) {
      for (let k = i; k < i + 3; k++) uv.setXY(k, pal.white[0], pal.white[1]);
    } else if (opts.roof && GREEN(u, v)) {
      for (let k = i; k < i + 3; k++) uv.setXY(k, uv.getX(k) + opts.roof[0] / 8, uv.getY(k) + opts.roof[1] / 4);
    }
  }
  uv.needsUpdate = true;
  variants.set(key, g);
  return g;
}
