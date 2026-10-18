// Orthographic camera at the mockups' 2:1 angle (30° elevation). Smooth 90° turns, zoom around the
// cursor, drag to pan, and eased moves to a point of interest.
import * as THREE from 'three';
import { WORLD } from '../map/layout';

const ELEV = THREE.MathUtils.degToRad(30);
const CENTER = new THREE.Vector3(WORLD.w / 2, 0, WORLD.h / 2);
// the county seen at 45°: about (w + h) / √2 across and half of that high, plus room for the panels
const SPAN = ((WORLD.w + WORLD.h) / Math.SQRT2) * 1.04;
const FIT_H = SPAN * 0.5 * 1.32;
export const MAX_ZOOM = 400; // street level: a house is ~100 px across
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

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
  private move: { from: THREE.Vector3; to: THREE.Vector3; z0: number; z1: number; t: number } | null = null;
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

  easeTo(x: number, z: number, zoom = Math.max(this.zoom, 6)): void {
    this.move = { from: this.target.clone(), to: new THREE.Vector3(x, 0, z), z0: this.zoom, z1: Math.min(MAX_ZOOM, zoom), t: 0 };
  }

  refit(): void { this.target.copy(CENTER); this.zoom = 1; this.apply(); }

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
      m.t = Math.min(1, m.t + dt / 650);
      const k = ease(m.t);
      this.target.lerpVectors(m.from, m.to, k);
      this.zoom = m.z0 * (m.z1 / m.z0) ** k; // even steps in scale, not in zoom number
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
