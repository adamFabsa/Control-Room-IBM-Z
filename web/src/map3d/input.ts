// Pointer input on the 3D canvas: drag to pan, wheel to zoom, hover and click to pick.
import type { Pick } from '../map/types';
import type { World } from './World';

export function attachInput(world: World, events: { onHover(p: Pick | null): void; onClick(p: Pick | null): void }): () => void {
  const el = world.renderer.domElement;
  let drag: { x: number; y: number; moved: boolean } | null = null;
  let hoverQueued: { x: number; y: number } | null = null;
  let raf = 0;

  const flushHover = () => {
    raf = 0;
    if (hoverQueued) events.onHover(world.pick(hoverQueued.x, hoverQueued.y));
    hoverQueued = null;
  };
  const down = (e: PointerEvent) => { el.setPointerCapture(e.pointerId); drag = { x: e.offsetX, y: e.offsetY, moved: false }; };
  const move = (e: PointerEvent) => {
    if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
      if (drag.moved) {
        world.rig.pan(dx, dy);
        drag.x = e.offsetX;
        drag.y = e.offsetY;
        el.style.cursor = 'grabbing';
        return;
      }
    }
    hoverQueued = { x: e.offsetX, y: e.offsetY };
    if (!raf) raf = requestAnimationFrame(flushHover); // at most one raycast per frame
  };
  const up = (e: PointerEvent) => {
    const d = drag;
    drag = null;
    el.style.cursor = '';
    if (d && !d.moved) events.onClick(world.pick(e.offsetX, e.offsetY));
  };
  const leave = () => events.onHover(null);
  const wheel = (e: WheelEvent) => { e.preventDefault(); world.rig.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); };
  const dbl = (e: MouseEvent) => { if (world.pick(e.offsetX, e.offsetY)) world.rig.zoomAt(e.offsetX, e.offsetY, 1.8); };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', leave);
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('dblclick', dbl);
  return () => {
    cancelAnimationFrame(raf);
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointerleave', leave);
    el.removeEventListener('wheel', wheel);
    el.removeEventListener('dblclick', dbl);
  };
}
