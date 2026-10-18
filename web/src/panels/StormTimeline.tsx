import { useId, useSyncExternalStore, type CSSProperties } from 'react';
import type { GameState } from '../contracts';
import { gameClock } from '../format';
import { goldenAt, nightAt } from '../sky';
import { useStore } from '../store';
import { clock12 } from './hud';

// The storm the game plays: Sun 14 Feb 18:00 CST for 114 hours, to Fri 19 Feb 12:00 CST (see link/mockLink.ts).
const STORM_START = Date.UTC(2021, 1, 15, 0, 0);
const STORM_HOURS = 114;
const SNOWY = 0.3;

const stormHour = (iso: string) => (Date.parse(iso) - STORM_START) / 3600e3;
const isoAt = (h: number) => new Date(STORM_START + h * 3600e3).toISOString();
/** CST hour of day for a storm hour (storm hour 0 is 18:00). */
const hourOfDay = (h: number) => gameClock(isoAt(h)).hour;
const pct = (h: number) => `${(Math.max(0, Math.min(STORM_HOURS, h)) / STORM_HOURS) * 100}%`;
const deg = (f: number) => `${f < 0 ? '−' : ''}${Math.abs(Math.round(f))}°`;
const when = (iso: string) => {
  const c = gameClock(iso);
  const t = clock12(c.time);
  return `${c.label} ${t.hm} ${t.ampm}`;
};

/* ---------- client-side history: one sample per game hour, kept across re-renders and remounts ---------- */

interface Sample { h: number; iso: string; f: number; snowy: boolean }
let samples: (Sample | undefined)[] = [];
let lastH = -Infinity;
let version = 0;
const listeners = new Set<() => void>();

function record(s: GameState | null): void {
  if (!s || (s.phase ?? 'storm') !== 'storm') return;
  const h = stormHour(s.time);
  if (!Number.isFinite(h) || h < 0 || h > STORM_HOURS) return;
  // time went backwards (a new storm): forget the hours after it
  if (h < lastH - 0.01) samples = samples.slice(0, Math.floor(h));
  lastH = h;
  const i = Math.floor(h);
  const prev = samples[i];
  const snowy = (s.weather?.snow ?? 0) > SNOWY;
  if (prev && prev.h === h && prev.f === s.outside_f) return;
  // keep the latest reading of the hour, so the line ends exactly at "now"; an hour is snowy if any of it was
  samples[i] = { h, iso: s.time, f: s.outside_f, snowy: snowy || (prev?.snowy ?? false) };
  version++;
  listeners.forEach((l) => l());
}

record(useStore.getState().state);
const unsubscribe = useStore.subscribe((st, prev) => { if (st.state !== prev.state) record(st.state); });
if (import.meta.hot) import.meta.hot.dispose(() => unsubscribe());

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getVersion = () => version;

/* ---------- the fixed parts of the strip: day ticks and the day/night rhythm ---------- */

interface Day { name: string; from: number; to: number }
const DAYS: Day[] = (() => {
  const out: Day[] = [];
  let from = 0;
  while (from < STORM_HOURS) {
    const to = Math.min(STORM_HOURS, from + 24 - hourOfDay(from));
    out.push({ name: gameClock(isoAt(from)).label.split(' ')[0], from, to });
    from = to;
  }
  return out;
})();

/** Daylight is a pale sky tint, night a deep navy, with a warm glow around sunrise and sunset (sky.ts). */
const BANDS = (() => {
  const day = [128, 178, 228, 0.17], night = [2, 6, 18, 0.55], gold = [255, 168, 96, 0.34];
  const color = (h: number) => {
    const hod = hourOfDay(h);
    const n = nightAt(hod);
    const g = Math.round(goldenAt(hod) * 0.6 * 50) / 50;
    const c = day.map((d, k) => d + (night[k] - d) * n).map((v, k) => v + (gold[k] - v) * g);
    return `rgba(${c.slice(0, 3).map(Math.round).join(',')},${c[3].toFixed(2)})`;
  };
  const step = 0.2;
  const n = Math.round(STORM_HOURS / step);
  const cols = Array.from({ length: n + 1 }, (_, i) => color(i * step));
  const stops = cols.flatMap((c, i) =>
    i === 0 || i === n || c !== cols[i - 1] || c !== cols[i + 1] ? [`${c} ${((i * step * 100) / STORM_HOURS).toFixed(2)}%`] : []);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
})();

/* ---------- the sparkline's scale ---------- */

const CH = 24; // chart height in viewBox units; x is in storm hours
const LO = -6, HI = 40, PAD = 3;
const yOf = (f: number) => PAD + (1 - (Math.max(LO, Math.min(HI, f)) - LO) / (HI - LO)) * (CH - 2 * PAD);
const ICE_LINE = 20; // ice at 20°F and up, cold-orange below (same as the temperature chip)

/** Slim strip under the clock: the 5-day storm with its nights, the outside temperature so far, snow, and now. */
export function StormTimeline() {
  const time = useStore((s) => s.state?.time);
  const storm = useStore((s) => (s.state?.phase ?? 'storm') === 'storm');
  const outside = useStore((s) => s.state?.outside_f);
  useSyncExternalStore(subscribe, getVersion);
  const gid = useId().replace(/:/g, '');
  if (!time || !storm) return null;

  const now = Math.max(0, Math.min(STORM_HOURS, stormHour(time)));
  const seen = samples.filter((s): s is Sample => !!s);

  // the line, broken where hours were skipped
  const segs: Sample[][] = [];
  for (const s of seen) {
    const seg = segs[segs.length - 1];
    if (seg && s.h - seg[seg.length - 1].h <= 1.6) seg.push(s);
    else segs.push([s]);
  }
  const line = segs.map((seg) => seg.map((s, i) => `${i ? 'L' : 'M'}${s.h.toFixed(3)} ${yOf(s.f).toFixed(2)}`).join('')).join('');
  const area = segs
    .filter((seg) => seg.length > 1)
    .map((seg) => `M${seg[0].h.toFixed(3)} ${CH}${seg.map((s) => `L${s.h.toFixed(3)} ${yOf(s.f).toFixed(2)}`).join('')}L${seg[seg.length - 1].h.toFixed(3)} ${CH}Z`)
    .join('');

  // snowy hours, merged into runs
  const snow: [number, number][] = [];
  for (const s of seen) {
    if (!s.snowy) continue;
    const i = Math.floor(s.h);
    const run = snow[snow.length - 1];
    if (run && run[1] >= i) run[1] = Math.min(now, i + 1);
    else snow.push([i, Math.min(now, i + 1)]);
  }
  const snowHours = seen.filter((s) => s.snowy).length;

  // the coldest reading so far (the first, if it repeats)
  const low = seen.reduce<Sample | null>((m, s) => (!m || s.f < m.f ? s : m), null);
  const lowSide = low && (low.h > STORM_HOURS - 14 || (now - low.h < 16 && low.h > 14)) ? 'left' : 'right';

  const today = DAYS.findIndex((d) => now >= d.from && now < d.to);
  const clock = gameClock(time);
  const t12 = clock12(clock.time);
  const dayNo = Math.min(5, Math.floor(now / 24) + 1);
  const summary = [
    `Storm timeline, Sunday 14 Feb 6 PM to Friday 19 Feb noon.`,
    `Now ${clock.label} ${t12.hm} ${t12.ampm}, day ${dayNo} of 5.`,
    outside != null ? `Outside ${deg(outside)}F.` : '',
    low ? `Coldest so far ${deg(low.f)}F, ${when(low.iso)}.` : '',
    snowHours ? `Snow in ${snowHours} of the hours so far.` : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="timeline" role="img" aria-label={summary} title={summary}>
      <div className="tl-bands" style={{ backgroundImage: BANDS }} />
      {snow.map(([a, b]) => <i key={a} className="tl-snow" style={{ left: pct(a), width: pct(b - a) }} />)}
      {DAYS.slice(1).map((d) => <i key={d.from} className="tl-tick" style={{ left: pct(d.from) }} />)}
      <i className="tl-past" style={{ width: pct(now) }} />

      <div className="tl-plot" aria-hidden="true">
        <svg viewBox={`0 0 ${STORM_HOURS} ${CH}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id={`tl-${gid}`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={CH}>
              <stop offset={yOf(ICE_LINE) / CH} className="tl-stop-ice" />
              <stop offset={yOf(ICE_LINE) / CH} className="tl-stop-cold" />
            </linearGradient>
          </defs>
          {area && <path className="tl-area" d={area} fill={`url(#tl-${gid})`} />}
          {line && <path className="tl-line" d={line} stroke={`url(#tl-${gid})`} vectorEffect="non-scaling-stroke" />}
        </svg>
        {low && (
          <span
            className={`tl-low ${low.f < ICE_LINE ? 'cold' : 'ice'} ${lowSide}`}
            style={{ left: pct(low.h), top: `${(yOf(low.f) / CH) * 100}%` } as CSSProperties}
          >
            <i />
            <b>{deg(low.f)}</b>
          </span>
        )}
      </div>

      <span className="tl-now" style={{ left: pct(now) }} aria-hidden="true" />

      <div className="tl-days" aria-hidden="true">
        {DAYS.map((d, i) => (
          <span key={d.from} className={i === today ? 'on' : undefined} style={{ left: i === 0 ? '4px' : pct((d.from + d.to) / 2) }} data-first={i === 0 || undefined}>
            {d.name}
          </span>
        ))}
      </div>
    </div>
  );
}
