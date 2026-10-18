// HTML layer over the canvas: status markers, map labels and the co-pilot pin.
// React renders the content; positions are written straight to the DOM every frame, and lower-priority
// labels hide when they would overlap a more important one, so the map never turns into a pile of tags.
import { Bot, CheckCircle2, GraduationCap, House, Landmark, Moon, Plus, PlugZap, Shield, Thermometer, Wrench, ZapOff, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Circuit } from '../contracts';
import { dur, fmt, shortDur } from '../format';
import { planEntries } from '../panels/PlanList';
import { useStore } from '../store';
import { anchorOf } from './controls';
import { AREA_LABELS, BUILDING_BY_ID, BUILDINGS, CIRCUIT_BY_ID, CIRCUITS } from './layout';
import './map.css';
import type { MapScene } from './types';

type Anchor = [gx: number, gy: number, height: number];
/** Higher wins a collision. */
const PRI = { copilot: 60, target: 58, badge: 55, alert: 50, selected: 40, marker: 30, area: 20, campus: 15, place: 10, landmark: 8 } as const;
/** County-wide items (conservation, repair crews) float over Downtown, the county seat. */
const COUNTY_ANCHOR = 'C-01';
const BADGE_LIFT = 46, BADGE_STEP = 30;

/** Lines whose ice damage was just repaired, for a few seconds of "Line fixed". */
function useRecentlyFixed(circuits: Circuit[] | undefined): string[] {
  const prev = useRef(new Set<string>());
  const [fixed, setFixed] = useState<string[]>([]);
  useEffect(() => {
    if (!circuits) return;
    const now = new Set(circuits.filter((c) => c.broken).map((c) => c.id));
    const done = [...prev.current].filter((id) => !now.has(id));
    prev.current = now;
    if (!done.length) return;
    setFixed((f) => [...f, ...done]);
    const t = setTimeout(() => setFixed((f) => f.filter((id) => !done.includes(id))), 3500);
    return () => clearTimeout(t);
  }, [circuits]);
  return fixed;
}
interface Item { el: HTMLElement; at: Anchor; pri: number; align: 'bottom' | 'center'; minZoom: number; lift: number; clamp?: boolean }

type MarkerKind = 'on' | 'dark' | 'cold' | 'protected' | 'broken';
function markerState(c: Circuit | undefined): { kind: MarkerKind; Icon: LucideIcon; label: string } {
  if (!c) return { kind: 'on', Icon: House, label: 'Powered' };
  if (c.broken) return { kind: 'broken', Icon: ZapOff, label: 'Ice broke the line' };
  if (!c.on && c.indoor_f < 50) return { kind: 'cold', Icon: Thermometer, label: 'Cold homes' };
  if (!c.on) return { kind: 'dark', Icon: Moon, label: 'Dark, still warm' };
  if (c.protected) return { kind: 'protected', Icon: Shield, label: 'Protected' };
  return { kind: 'on', Icon: House, label: 'Powered' };
}

export function MapOverlay({ scene }: { scene: MapScene }) {
  const items = useRef(new Map<string, Item>());
  const root = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const circuits = useStore((s) => s.state?.circuits);
  const copilot = useStore((s) => s.state?.copilot);
  const phase = useStore((s) => s.state?.phase ?? 'storm');
  const selected = useStore((s) => s.ui.selected);
  const hover = useStore((s) => s.ui.hover);
  const mapClick = useStore((s) => s.mapClick);
  const state = useStore((s) => s.state);
  const tool = useStore((s) => s.ui.tool);
  const buyItem = useStore((s) => s.ui.buyItem);
  const emergencyItem = useStore((s) => s.ui.emergencyItem);
  const hoverId = hover ? (hover.kind === 'circuit' ? hover.id : hover.circuit) : null;
  const fixed = useRecentlyFixed(circuits);

  useEffect(() => {
    const p = { x: 0, y: 0 };
    const placed: [number, number, number, number][] = [];
    const W = () => window.innerWidth, H = () => window.innerHeight;
    return scene.onFrame(() => {
      const zoom = scene.getZoom();
      root.current?.classList.toggle('ov-day', scene.getNight() < 0.5);
      root.current?.classList.toggle('ov-night', scene.getNight() >= 0.5);
      const list = [...items.current.values()].sort((a, b) => b.pri - a.pri);
      placed.length = 0;
      for (const it of list) {
        scene.toScreen(it.at[0], it.at[1], it.at[2], p);
        p.y -= it.lift;
        const w = it.el.offsetWidth, h = it.el.offsetHeight;
        if (it.clamp) { // keep speech bubbles on screen
          p.x = Math.max(w / 2 + 16, Math.min(W() - w / 2 - 16, p.x));
          p.y = Math.max(h + 190, Math.min(H() - 120, p.y)); // below the top panels, above the tool dock
        }
        it.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
        const x0 = p.x - w / 2 - 3, x1 = p.x + w / 2 + 3;
        const y0 = it.align === 'bottom' ? p.y - h - 2 : p.y - h / 2 - 2, y1 = it.align === 'bottom' ? p.y + 2 : p.y + h / 2 + 2;
        let show = zoom >= it.minZoom && x1 > 0 && x0 < W() && y1 > 0 && y0 < H();
        if (show) for (const r of placed) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) { show = false; break; }
        if (show) placed.push([x0, y0, x1, y1]);
        it.el.classList.toggle('ov-hidden', !show);
      }
    });
  }, [scene]);

  const bind = (key: string, at: Anchor, pri: number, align: Item['align'], minZoom = 0, lift = 0, clamp = false) => (el: HTMLElement | null) => {
    if (el) items.current.set(key, { el, at, pri, align, minZoom, lift, clamp });
    else items.current.delete(key);
  };

  const cpAt = copilot?.target ? anchorOf(copilot.target) : null;
  const day = phase === 'ready';
  // where each placed item sits, stacked when several share a building or district
  const stack = new Map<string, number>();
  const badges = (state ? planEntries(state) : []).map((e) => {
    const at = e.focus ?? COUNTY_ANCHOR;
    const i = stack.get(at) ?? 0;
    stack.set(at, i + 1);
    return { e, at, i };
  });
  const placingGenerator = (phase === 'ready' && tool === 'buy' && buyItem === 'generator') || (tool === 'emergency' && emergencyItem === 'generator');
  const genTargets = placingGenerator ? BUILDINGS.filter((b) => b.kind !== 'school' && !state?.buildings.find((x) => x.id === b.id)?.generator) : [];
  const crews = !!state?.prep?.repair_crews;

  return (
    <div className={`overlay ov ${day ? 'ov-day' : 'ov-night'}`} ref={root}>
      <HoverTip tipRef={tip} />
      {AREA_LABELS.map((l, i) => (
        <div
          key={`l${i}`}
          className={l.kind === 'area' ? 'ov-area' : `ov-place ${l.kind}`}
          ref={bind(`l${i}`, [l.x, l.y, 0.02], l.kind === 'area' ? PRI.area : l.kind === 'campus' ? PRI.campus : l.kind === 'landmark' ? PRI.landmark : PRI.place, 'center', l.minZoom)}
        >
          {l.kind === 'campus' && <GraduationCap size={12} strokeWidth={2.4} aria-hidden />}
          {l.kind === 'landmark' && <Landmark size={11} strokeWidth={2.4} aria-hidden />}
          {l.text}
        </div>
      ))}
      {CIRCUITS.map((info) => {
        const c = circuits?.find((x) => x.id === info.id);
        const { kind, Icon, label } = markerState(c);
        const [cx, cy] = info.center;
        const timer = c && !c.on && c.restore_in_min != null && c.restore_in_min > 0;
        const total = timer ? c!.restore_in_min! + c!.dark_min : 1;
        const p = timer ? c!.restore_in_min! / total : 0;
        const isSel = selected === info.id, isHover = hoverId === info.id;
        const alert = kind === 'cold' || kind === 'dark' || kind === 'broken';
        const pri = alert ? PRI.alert : isSel || isHover ? PRI.selected : PRI.marker;
        const showName = alert || isSel || isHover;
        return (
          <div key={info.id} className="ov-anchor" ref={bind(info.id, [cx, cy, scene.topOf(info.id) + 0.12], pri, 'bottom')}>
            <button
              type="button"
              className={`ov-marker ${kind}${isSel ? ' selected' : ''}${isHover ? ' hover' : ''}`}
              aria-label={`${info.area} ${info.id}: ${label}`}
              onClick={() => mapClick({ kind: 'circuit', id: info.id })}
            >
              {showName && (
                <span className="ov-tag">
                  <span className="ov-name">{info.area}</span>
                  {c && !c.on && <b>{Math.round(c.indoor_f)}°F</b>}
                  {timer && <span className="ov-time">{shortDur(c!.restore_in_min!)}</span>}
                  {c?.on && <span className="ov-id">{info.id}</span>}
                </span>
              )}
              <span className="ov-pin" style={{ ['--p' as string]: p }}>
                {timer && <span className="ov-timer" />}
                {kind !== 'on' && <Icon size={14} strokeWidth={2.5} />}
              </span>
            </button>
          </div>
        );
      })}
      {badges.map(({ e, at, i }) => {
        const a = anchorOf(at);
        if (!a) return null;
        return (
          <div key={`b-${e.key}`} className="ov-anchor" ref={bind(`b-${e.key}`, [a[0], a[1], scene.topOf(at) + 0.12], PRI.badge, 'bottom', 0, BADGE_LIFT + i * BADGE_STEP)}>
            <div className={`ov-badge${day ? ' wide' : ''}`} style={{ '--c': e.color } as CSSProperties} title={`${e.name} · ${e.where}`}>
              <span className="ov-badge-ico"><e.Icon size={day ? 15 : 13} strokeWidth={2.5} /></span>
              {day && <span className="ov-badge-text">{e.name}</span>}
            </div>
          </div>
        );
      })}
      {genTargets.map((b) => (
        <div key={`t-${b.id}`} className="ov-anchor" ref={bind(`t-${b.id}`, [b.at[0], b.at[1], scene.topOf(b.id) + 0.12], PRI.target, 'bottom', 0, BADGE_LIFT + (stack.get(b.id) ?? 0) * BADGE_STEP)}>
          <button type="button" className="ov-target" onClick={() => mapClick({ kind: 'building', id: b.id, circuit: b.circuit })}>
            <Plus size={13} strokeWidth={3} /><PlugZap size={13} strokeWidth={2.5} /> {b.name}
          </button>
        </div>
      ))}
      {(circuits ?? []).filter((c) => c.broken || fixed.includes(c.id)).map((c) => {
        const id = c.parent ?? c.id;
        const a = anchorOf(id);
        if (!a) return null;
        const done = !c.broken;
        return (
          <div key={`r-${c.id}`} className="ov-anchor" ref={bind(`r-${c.id}`, [a[0], a[1], scene.topOf(id) + 0.12], PRI.badge, 'bottom', 0, BADGE_LIFT)}>
            <div className={`ov-crew${done ? ' fixed' : ''}`}>
              {done ? <CheckCircle2 size={14} strokeWidth={2.6} /> : <Wrench size={14} strokeWidth={2.6} className="ov-wrench" />}
              {done ? 'Line fixed' : crews ? 'Crews fixing · 2 h' : 'Crews on the way · 6 h'}
            </div>
          </div>
        );
      })}
      {copilot && cpAt && copilot.target && (
        <div className="ov-anchor" ref={bind(`cp-${copilot.target}`, [cpAt[0], cpAt[1], scene.topOf(copilot.target) + 0.12], PRI.copilot, 'bottom', 0, 76, true)}>
          <div className={`ov-copilot${day ? ' ready' : ''}`}>
            <span className="who"><Bot size={14} strokeWidth={2.4} /> AI co-pilot</span>
            <span>{copilot.tip}</span>
            <span className="leader" aria-hidden />
          </div>
        </div>
      )}
    </div>
  );
}

/** A small card that follows the pointer: what this neighborhood is and what a click will do. */
function HoverTip({ tipRef }: { tipRef: React.RefObject<HTMLDivElement | null> }) {
  const hover = useStore((s) => s.ui.hover);
  const tool = useStore((s) => s.ui.tool);
  const minutes = useStore((s) => s.ui.cutMinutes);
  const emergency = useStore((s) => s.ui.emergencyItem);
  const phase = useStore((s) => s.state?.phase);
  const id = hover ? (hover.kind === 'circuit' ? hover.id : hover.circuit) : null;
  const c = useStore((s) => (id ? s.state?.circuits.find((x) => x.id === id) : undefined));
  const b = useStore((s) => (hover?.kind === 'building' ? s.state?.buildings.find((x) => x.id === hover.id) : undefined));

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = tipRef.current;
      if (!el) return;
      const right = e.clientX > window.innerWidth - 300;
      el.style.transform = `translate3d(${e.clientX + (right ? -16 : 18)}px, ${e.clientY + 20}px, 0) translateX(${right ? '-100%' : '0'})`;
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [tipRef]);

  if (!id || !c || phase === 'over') return <div className="ov-tip-anchor" ref={tipRef} />;
  const info = CIRCUIT_BY_ID[id];
  const bInfo = hover?.kind === 'building' ? BUILDING_BY_ID[hover.id] : undefined;
  const cold = !c.on && c.indoor_f < 50;
  const state = c.protected ? 'Protected' : c.broken ? 'Ice broke the line' : c.on ? 'Powered' : cold ? 'Dark and cold' : 'Dark, still warm';
  let action: string | null = null;
  if (phase === 'storm') {
    if (tool === 'cut') action = c.protected ? "Protected: can't be cut" : c.on ? `Click to cut for ${minutes ? (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`) : 'until restored'} · +${fmt(c.mw)} MW` : 'Already dark · click to set a new timer';
    else if (tool === 'restore') action = c.on ? 'Already has power' : `Click to turn power back on · −${fmt(c.mw)} MW`;
    else if (tool === 'emergency' && emergency === 'generator') action = bInfo || info?.building ? 'Click to send the generator here' : 'No critical building here';
    else action = 'Click for details';
  }
  return (
    <div className="ov-tip-anchor" ref={tipRef}>
      <div className={`ov-tip ${cold ? 'cold' : !c.on ? 'dark' : c.protected ? 'protected' : 'on'}`}>
        <div className="ov-tip-head">
          <b>{bInfo ? bInfo.name : info?.area}</b>
          <span>{id}</span>
        </div>
        {b && bInfo && <div className="ov-tip-row">{b.on ? 'Running' : b.generator ? 'On generator' : 'Without power'}{b.fuel_h != null && b.generator ? ` · ${Math.round(b.fuel_h)} h fuel` : ''}</div>}
        <div className="ov-tip-row">
          <span>{state}</span>
          <span className="num">{Math.round(c.indoor_f)}°F inside</span>
        </div>
        <div className="ov-tip-row muted">
          <span>{fmt(c.people)} people · {fmt(c.mw)} MW</span>
          {!c.on && <span className="num">dark {dur(c.dark_min)}</span>}
        </div>
        {action && <div className="ov-tip-action">{action}</div>}
      </div>
    </div>
  );
}
