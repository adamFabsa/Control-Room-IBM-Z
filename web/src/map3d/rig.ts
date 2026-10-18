// Orthographic camera at the mockups' 2:1 angle (30° elevation). Smooth 90° turns, zoom around the
// cursor, drag to pan, and smooth flights to a point of interest (zooming out on the way when it is far).
import * as THREE from 'three';
import { WORLD } from '../map/layout';

const ELEV = THREE.MathUtils.degToRad(30);
const CENTER = new THREE.Vector3(WORLD.w / 2, 0, WORLD.h / 2);
// the county seen at 45°: about (w + h) / √2 across and half of that high, plus room for the panels
const SPAN = ((WORLD.w + WORLD.h) / Math.SQRT2) * 1.04;
const FIT_H = SPAN * 0.5 * 1.32;
export const MAX_ZOOM = 400; // street level: a house is ~100 px across
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const RHO = 1.3; // how much a long flight zooms out on the way (van Wijk & Nuij; d3 uses √2)

/** A smooth zoom-and-pan path between two views (van Wijk & Nuij 2003, as in d3.interpolateZoom), where `w` is
 *  the visible width in world units. Moves at an even perceived speed, so a far jump zooms out, travels and zooms
 *  back in instead of streaking across the screen. Returns the path and its length S (about seconds at 1×). */
function zoomPath(x0: number, z0: number, w0: number, x1: number, z1: number, w1: number) {
  const dx = x1 - x0, dz = z1 - z0, d2 = dx * dx + dz * dz, r2 = RHO * RHO;
  if (d2 < 1e-8) {
    const S = Math.abs(Math.log(w1 / w0)) / RHO;
    return { S, at: (k: number): [number, number, number] => [x0 + k * dx, z0 + k * dz, w0 * (w1 / w0) ** k] };
  }
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * d2) / (2 * w0 * r2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - r2 * r2 * d2) / (2 * w1 * r2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / RHO;
  return {
    S,
    at: (k: number): [number, number, number] => {
      const s = k * S, c0 = Math.cosh(r0);
      const u = (w0 / (r2 * d1)) * (c0 * Math.tanh(RHO * s + r0) - Math.sinh(r0));
      return [x0 + u * dx, z0 + u * dz, (w0 * c0) / Math.cosh(RHO * s + r0)];
    },
  };
}

export class Rig {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
  readonly target = CENTER.clone();
  zoom = 1;
  private az = Math.PI / 4;
  private azFrom = this.az;
  private azTo = this.az;
  private azT = 1;
  private w = 1;
  private h = 1;
  private fitH = FIT_H;
  private move: { at: (k: number) => [number, number, number]; ms: number; t: number } | null = null;
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ray = new THREE.Raycaster();

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    const aspect = w / h;
    // keep the whole slab in view: its diagonal (~57) across, ~36 high
    this.fitH = Math.max(FIT_H, SPAN / aspect);
    const half = this.fitH / 2;
    Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    this.apply();
  }

  /** Quarter turns from the default view; animates the long way never. */
  setRotation(rot: number): void {
    const goal = Math.PI / 4 + (rot * Math.PI) / 2;
    let delta = goal - this.az;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.azFrom = this.az;
    this.azTo = this.az + delta;
    this.azT = 0;
  }

  get unitsPerPx(): number { return this.fitH / this.zoom / this.h; }

  pan(dx: number, dy: number): void {
    this.move = null;
    const k = this.unitsPerPx;
    const right = new THREE.Vector3(Math.sin(this.az), 0, -Math.cos(this.az));
    const toward = new THREE.Vector3(Math.cos(this.az), 0, Math.sin(this.az));
    this.target.addScaledVector(right, -dx * k).addScaledVector(toward, -dy * k / Math.sin(ELEV));
    this.clamp();
    this.apply();
  }

  groundAt(px: number, py: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    this.ray.setFromCamera(new THREE.Vector2((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1), this.camera);
    return this.ray.ray.intersectPlane(this.ground, out);
  }

  zoomAt(px: number, py: number, k: number): void {
    this.move = null;
    const before = this.groundAt(px, py);
    this.zoom = Math.min(MAX_ZOOM, Math.max(0.7, this.zoom * k));
    this.apply();
    const after = this.groundAt(px, py);
    if (before && after) this.target.add(before.sub(after));
    this.clamp();
    this.apply();
  }

  zoomBy(k: number): void { this.zoomAt(this.w / 2, this.h / 2, k); }

  /** Fly to a point and zoom. Short hops take about half a second, a cross-county flight up to 1.8 s. */
  easeTo(x: number, z: number, zoom = Math.max(this.zoom, 6)): void {
    const across = this.fitH * (this.w / this.h); // visible width at zoom 1
    const z1 = Math.min(MAX_ZOOM, Math.max(0.7, zoom));
    const path = zoomPath(this.target.x, this.target.z, across / this.zoom, x, z, across / z1);
    if (!Number.isFinite(path.S) || path.S < 0.01) { this.jumpTo(x, z, z1); return; }
    this.move = {
      at: (k) => { const [px, pz, w] = path.at(k); return [px, pz, across / w]; },
      ms: Math.min(1800, Math.max(500, path.S * 750)),
      t: 0,
    };
  }

  /** Back to the whole county, flown rather than cut. */
  refit(): void { this.easeTo(CENTER.x, CENTER.z, 1); }

  /** Where the camera is now, to come back to later. */
  view(): [number, number, number] { return [this.target.x, this.target.z, this.zoom]; }

  /** Jump straight to a view (no easing), e.g. for ?cam=x,z,zoom in video takes. */
  jumpTo(x: number, z: number, zoom: number): void {
    this.move = null;
    this.target.set(x, 0, z);
    this.zoom = Math.min(MAX_ZOOM, Math.max(0.7, zoom));
    this.clamp();
    this.apply();
  }

  update(dt: number): void {
    let dirty = false;
    if (this.azT < 1) {
      this.azT = Math.min(1, this.azT + dt / 520);
      this.az = this.azFrom + (this.azTo - this.azFrom) * ease(this.azT);
      dirty = true;
    }
    if (this.move) {
      const m = this.move;
      m.t = Math.min(1, m.t + dt / m.ms);
      const [x, z, zoom] = m.at(ease(m.t));
      this.target.set(x, 0, z);
      this.zoom = zoom;
      if (m.t >= 1) this.move = null;
      dirty = true;
    }
    if (dirty) this.apply();
  }

  private clamp(): void {
    this.target.x = Math.min(WORLD.w + 4, Math.max(-4, this.target.x));
    this.target.z = Math.min(WORLD.h + 4, Math.max(-4, this.target.z));
  }

  private apply(): void {
    const d = 100;
    const c = this.camera;
    c.position.set(
      this.target.x + Math.cos(this.az) * Math.cos(ELEV) * d,
      this.target.y + Math.sin(ELEV) * d,
      this.target.z + Math.sin(this.az) * Math.cos(ELEV) * d,
    );
    c.zoom = this.zoom;
    c.lookAt(this.target);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }
}
