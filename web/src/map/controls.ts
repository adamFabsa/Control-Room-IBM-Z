// A small bridge so React panels can drive the camera without owning it.
import type { World } from '../map3d/World';
import { BUILDING_BY_ID, CIRCUIT_BY_ID } from './layout';

let world: World | null = null;

export function bindControls(w: World | null): void {
  world = w;
}

export function anchorOf(id: string): [number, number] | null {
  const c = CIRCUIT_BY_ID[id];
  if (c) return c.center;
  const b = BUILDING_BY_ID[id];
  if (b) return b.at;
  return null;
}

export const mapControls = {
  zoomBy(k: number) { world?.rig.zoomBy(k); },
  refit() { world?.rig.refit(); },
  /** Ease to a neighborhood or building. `zoom` is on the old county scale (3 ≈ a few blocks); homes are now
   *  at near-real size, so it is doubled here. */
  focus(id: string, zoom = 3) {
    const a = anchorOf(id);
    if (a) world?.rig.easeTo(a[0], a[1], zoom * 2);
  },
};
