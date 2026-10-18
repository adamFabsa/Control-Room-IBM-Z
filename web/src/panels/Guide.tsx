import { ArrowRight, Check, Scissors, Thermometer, Zap, type LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';

// First-play guide: three coach marks over the live storm HUD. Not a modal; the map stays visible and playable.

const SEEN_KEY = 'control-room-uri.guide-seen';

function wasSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}
function markSeen(): void {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage blocked: the guide just shows again next time */ }
}
function forced(): boolean {
  try { return new URLSearchParams(window.location.search).get('guide') === '1'; } catch { return false; }
}

interface Step {
  /** the HUD element to ring */
  target: string;
  /** what the arrow points at (defaults to the target) */
  point?: string;
  /** the edge the bubble sits against (defaults to the target) */
  anchor?: string;
  place: 'above' | 'below';
  Icon: LucideIcon;
  color: string;
  title: string;
  text: ReactNode;
}

const STEPS: Step[] = [
  {
    target: '.order-bar', place: 'below', Icon: Zap, color: 'var(--amber)',
    title: 'The grid operator orders cuts.', text: 'Meet the order at the top.',
  },
  {
    target: '.dock', point: '.dock-btn.cut', anchor: '.slot.bottom-center', place: 'above', Icon: Scissors, color: 'var(--amber)',
    title: 'Pick Cut power, then click neighborhoods.', text: 'Cuts are timed: 2 hours by default.',
  },
  {
    target: '.stat.cold', place: 'below', Icon: Thermometer, color: 'var(--cold)',
    title: 'Watch homes cool.', text: <><span className="guide-orange">Orange</span> means below 50°F inside. Restore before people get cold.</>,
  },
];

const useGuide = create<{ open: boolean; step: number }>(() => ({ open: false, step: 0 }));

/** Open, advance and close the guide from anywhere (the ? button, the ? key). */
export const guide = {
  show() { useGuide.setState({ open: true, step: 0 }); },
  close() { markSeen(); useGuide.setState({ open: false, step: 0 }); },
  next() {
    const { step } = useGuide.getState();
    if (step >= STEPS.length - 1) guide.close();
    else useGuide.setState({ step: step + 1 });
  },
  toggle() { if (useGuide.getState().open) guide.close(); else guide.show(); },
};
export const useGuideOpen = () => useGuide((s) => s.open);

let autoShown = false; // once per page load

interface Geo { ring: DOMRect; anchor: DOMRect; pointX: number; radius: number; vw: number; vh: number }
const RING_PAD = 6;
const GAP = 22;
const EDGE = 16;

/** Keep the ring and bubble on the target every frame: panels pop in, grow and move as the game runs. */
function useGeo(step: Step | null): Geo | null {
  const [geo, setGeo] = useState<Geo | null>(null);
  useLayoutEffect(() => {
    if (!step) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const el = document.querySelector<HTMLElement>(step.target);
      if (!el) {
        if (last !== 'none') { last = 'none'; setGeo(null); }
      } else {
        const ring = el.getBoundingClientRect();
        const anchor = (step.anchor && document.querySelector(step.anchor)?.getBoundingClientRect()) || ring;
        const p = (step.point && document.querySelector(step.point)?.getBoundingClientRect()) || ring;
        const pointX = p.left + p.width / 2;
        const key = [ring.left, ring.top, ring.width, ring.height, anchor.top, anchor.bottom, pointX, innerWidth, innerHeight].map(Math.round).join();
        if (key !== last) {
          last = key;
          const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 16;
          setGeo({ ring, anchor, pointX, radius, vw: innerWidth, vh: innerHeight });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step]);
  return step ? geo : null;
}

export function Guide() {
  const { open, step } = useGuide();
  const eventOpen = useStore((s) => !!s.state?.event);
  const visible = open && !eventOpen; // a decision card wins; the guide comes back after it
  const s = visible ? STEPS[step] : null;
  const geo = useGeo(s);
  const tipRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const last = step === STEPS.length - 1;

  // the first storm (or ?guide=1): open once the HUD has popped in
  useEffect(() => {
    if (autoShown || (!forced() && wasSeen())) return;
    const id = setTimeout(() => { autoShown = true; guide.show(); }, 450);
    return () => clearTimeout(id);
  }, []);

  // While it's up, the guide owns Enter and Esc. It listens in the capture phase so StormScreen's map keys never
  // see them; every other key (Space, C, R, 1–5…) still reaches the game.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Enter' && e.key !== 'Escape') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (useStore.getState().state?.event) return; // a decision card just opened: its Enter wins
      e.stopPropagation();
      const el = document.activeElement;
      if (e.key === 'Enter' && !e.repeat && el instanceof HTMLButtonElement && tipRef.current?.contains(el)) return; // let Skip / Next click
      e.preventDefault();
      if (e.repeat) return;
      if (e.key === 'Enter') guide.next();
      else guide.close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible]);

  // keyboard and screen-reader users land on the main button of each step
  useEffect(() => {
    if (visible) nextRef.current?.focus({ preventScroll: true });
  }, [visible, step]);

  if (!s) return null;

  const vw = geo?.vw ?? innerWidth, vh = geo?.vh ?? innerHeight;
  const w = Math.min(340, vw - 2 * EDGE);
  const cx = geo ? geo.pointX : vw / 2;
  const left = Math.max(EDGE, Math.min(vw - EDGE - w, cx - w / 2));
  const arrow = Math.max(26, Math.min(w - 26, cx - left));
  const tipPos: CSSProperties = !geo
    ? { left, top: Math.round(vh * 0.28), width: w }
    : s.place === 'below'
      ? { left, top: Math.round(geo.anchor.bottom + GAP), width: w }
      : { left, bottom: Math.round(vh - geo.anchor.top + GAP), width: w };

  return (
    <div className="guide">
      {geo && (
        <div
          className="guide-ring"
          aria-hidden="true"
          style={{
            left: geo.ring.left - RING_PAD, top: geo.ring.top - RING_PAD,
            width: geo.ring.width + 2 * RING_PAD, height: geo.ring.height + 2 * RING_PAD,
            borderRadius: geo.radius + RING_PAD,
          }}
        />
      )}
      <div
        ref={tipRef}
        key={step}
        className={`panel guide-tip pop ${geo ? s.place : 'free'}`}
        style={tipPos}
        role="dialog"
        aria-modal="false"
        aria-labelledby="guide-title"
        aria-describedby="guide-text"
      >
        {geo && <span className="guide-arrow" style={{ left: arrow }} aria-hidden="true" />}
        <div className="guide-body">
          <span className="ex-ico" style={{ '--c': s.color } as CSSProperties} aria-hidden="true"><s.Icon size={20} strokeWidth={2.4} /></span>
          <div className="guide-copy">
            <span className="eyebrow ice">How to play · {step + 1} of {STEPS.length}</span>
            <b id="guide-title">{s.title}</b>
            <p id="guide-text">{s.text}</p>
          </div>
        </div>
        <div className="guide-foot">
          <span className="guide-dots" aria-hidden="true">
            {STEPS.map((_, i) => <i key={i} className={i === step ? 'on' : i < step ? 'done' : undefined} />)}
          </span>
          <button type="button" className="guide-skip" aria-keyshortcuts="Escape" title="Skip the guide · Esc" onClick={guide.close}>Skip</button>
          <button
            ref={nextRef}
            type="button"
            className="gbtn ice guide-next"
            aria-keyshortcuts="Enter"
            title={`${last ? 'Close the guide' : 'Next tip'} · Enter`}
            onClick={guide.next}
          >
            {last ? <><Check size={17} strokeWidth={3} /> Got it</> : <>Next <ArrowRight size={17} strokeWidth={2.8} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
