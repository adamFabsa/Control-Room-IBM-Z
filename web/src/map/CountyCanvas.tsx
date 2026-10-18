import { useEffect, useRef, useState } from 'react';
import { gameClock } from '../format';
import { goldenAt, nightAt } from '../sky';
import { attachInput } from '../map3d/input';
import { World } from '../map3d/World';
import { useStore } from '../store';
import { bindControls } from './controls';
import { BUILDINGS, CIRCUITS } from './layout';
import { MapOverlay } from './MapOverlay';
import './map.css';
import type { Pick } from './types';

const samePick = (a: Pick | null, b: Pick | null) => a?.kind === b?.kind && a?.id === b?.id;

export function CountyCanvas() {
  const host = useRef<HTMLDivElement>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [loading, setLoading] = useState<{ step: string; p: number } | null>({ step: 'Reading the county map', p: 0 });

  // the panels wait for the county: hidden while it builds, then fade in
  useEffect(() => {
    document.documentElement.classList.toggle('county-building', !!loading);
  }, [loading]);

  useEffect(() => {
    const el = host.current!;
    const w = new World(el);
    let alive = true;
    let teardown = () => {};
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    w.load((step, p) => alive && setLoading({ step, p: 0.1 + p * 0.6 })).then(async () => {
      if (!alive) return;
      setLoading({ step: 'Painting 56,000 streets and every building', p: 0.78 });
      await frame(); // let the label show before the heavy build
      if (!alive) return;
      // ?cam=x,z,zoom opens on a framed view (screenshots, video takes)
      const cam = new URLSearchParams(location.search).get('cam')?.split(',').map(Number);
      if (cam && cam.length >= 2 && cam.every(Number.isFinite)) w.rig.jumpTo(cam[0], cam[1], cam[2] ?? 6);
      const s0 = useStore.getState().state;
      w.setSnow(s0 ? s0.phase !== 'ready' : true);
      setLoading(null);
      const detach = attachInput(w, {
        onHover: (p) => {
          const st = useStore.getState();
          if (!samePick(st.ui.hover, p)) st.setUI({ hover: p });
        },
        onClick: (p) => useStore.getState().mapClick(p),
      });
      bindControls(w);
      useStore.getState().setFlash((id) => w.flash(id));

      // cross-fade from a snapshot of the old frame when the county gets its snow
      const fade = (ms: number) => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const snap = w.snapshot();
        snap.className = 'snap';
        snap.style.transition = `opacity ${ms}ms ease`;
        el.appendChild(snap);
        requestAnimationFrame(() => requestAnimationFrame(() => { snap.style.opacity = '0'; }));
        setTimeout(() => snap.remove(), ms + 60);
      };
      const sync = (s: ReturnType<typeof useStore.getState>, prev?: ReturnType<typeof useStore.getState>) => {
        if (s.state && s.state !== prev?.state) {
          const snow = s.state.phase !== 'ready';
          if (prev?.state && prev.state.phase !== s.state.phase && snow) fade(1200);
          w.setSnow(snow);
          const hour = gameClock(s.state.time).hour;
          w.setDaylight(s.state.phase === 'ready' ? 0 : nightAt(hour), s.state.phase === 'ready' ? 0 : goldenAt(hour));
          w.setState(s.state);
        }
        if (s.ui !== prev?.ui) {
          w.rig.setRotation(s.ui.rot);
          const buildingTool = (s.ui.tool === 'buy' && s.ui.buyItem === 'generator') || (s.ui.tool === 'emergency' && s.ui.emergencyItem === 'generator');
          const circuitTool = s.ui.tool === 'buy' && (s.ui.buyItem === 'protect' || s.ui.buyItem === 'smart_switch');
          w.setUI({
            hover: s.ui.hover, selected: s.ui.selected, tool: s.ui.tool,
            targets: buildingTool ? 'buildings' : circuitTool ? 'circuits' : null,
          });
        }
      };
      sync(useStore.getState());
      const unsub = useStore.subscribe((s, prev) => sync(s, prev));
      const ro = new ResizeObserver(() => w.resize());
      ro.observe(el);
      setWorld(w);
      if (import.meta.env.DEV) (window as unknown as { __cr: unknown }).__cr = { world: w, store: useStore, circuits: CIRCUITS, buildings: BUILDINGS };
      teardown = () => { unsub(); ro.disconnect(); detach(); bindControls(null); };
    });
    return () => {
      alive = false;
      teardown();
      w.dispose();
    };
  }, []);

  return (
    <div className="map-host" ref={host}>
      {world && <MapOverlay scene={world} />}
      <p className="map-credit">Buildings © OpenStreetMap contributors, Microsoft · US Census TIGER · CDC SVI</p>
      {loading && (
        <div className="county-loading" role="status" aria-live="polite">
          <div className="cl-card">
            <span className="cl-brand">CONTROL ROOM: URI</span>
            <h1>Building Dallas County</h1>
            <p className="cl-step">{loading.step}…</p>
            <div className="cl-bar"><i style={{ width: `${Math.round(loading.p * 100)}%` }} /></div>
            <p className="cl-facts">645 census tracts · 2.6 million people · every street and building</p>
          </div>
        </div>
      )}
    </div>
  );
}
