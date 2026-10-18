// Isometric (2:1) projection and the 4-step view rotation.
// World grid: gx, gy in tiles on a 40×40 slab. View grid: the world grid turned by `rot` quarter turns.
// Every position goes world → view → screen, so rotation works everywhere from the start.

export const N = 40;
export const TW2 = 16; // half tile width in world px
export const TH2 = 8; // half tile height in world px

export type Rot = 0 | 1 | 2 | 3;
export type Rect = [x: number, y: number, w: number, d: number];

/** World sides: 0 = north (−y), 1 = east (+x), 2 = south (+y), 3 = west (−x). */
export type Side = 0 | 1 | 2 | 3;

export function toView(gx: number, gy: number, rot: Rot): [number, number] {
  switch (rot) {
    case 0: return [gx, gy];
    case 1: return [N - gy, gx];
    case 2: return [N - gx, N - gy];
    case 3: return [gy, N - gx];
  }
}

export function fromView(vx: number, vy: number, rot: Rot): [number, number] {
  switch (rot) {
    case 0: return [vx, vy];
    case 1: return [vy, N - vx];
    case 2: return [N - vx, N - vy];
    case 3: return [N - vy, vx];
  }
}

export function rectToView([x, y, w, d]: Rect, rot: Rot): Rect {
  const [ax, ay] = toView(x, y, rot);
  const [bx, by] = toView(x + w, y + d, rot);
  return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
}

/** A world side as seen after rotation. In view, side 2 (+vy) is the left-front face, side 1 (+vx) the right-front face. */
export function sideToView(side: Side, rot: Rot): Side {
  return ((side + rot) % 4) as Side;
}

export function project(vx: number, vy: number, z = 0): [number, number] {
  return [(vx - vy) * TW2, (vx + vy) * TH2 - z];
}

export function unproject(sx: number, sy: number): [number, number] {
  return [(sy / TH2 + sx / TW2) / 2, (sy / TH2 - sx / TW2) / 2];
}

/** Depth key for painter's sorting: larger is nearer the viewer. */
export function depth(vx: number, vy: number): number {
  return vx + vy;
}

export function rectCenter([x, y, w, d]: Rect): [number, number] {
  return [x + w / 2, y + d / 2];
}

export function inRect(px: number, py: number, [x, y, w, d]: Rect, pad = 0): boolean {
  return px >= x - pad && px <= x + w + pad && py >= y - pad && py <= y + d + pad;
}

/** Screen outline of a box standing on a view rect: the 6-point silhouette, for hit-testing tall objects. */
export function silhouette([x, y, w, d]: Rect, h: number): number[] {
  const pts = [
    project(x, y + d), project(x + w, y + d), project(x + w, y),
    project(x + w, y, h), project(x, y, h), project(x, y + d, h),
  ];
  return pts.flat();
}

export function pointInPoly(px: number, py: number, poly: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
