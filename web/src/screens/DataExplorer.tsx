import { Download, LineChart as LineIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Report } from '../contracts';
import { fmt, gameClock } from '../format';
import { compact } from '../panels/hud';

type Explorer = NonNullable<Report['series']>;
type Metric = Explorer['metrics'][number];
type Game = 'player' | 'playbook_2021' | 'ai_alone';

const GAMES: { id: Game; label: string; cls: string }[] = [
  { id: 'player', label: 'You', cls: 'l-you' },
  { id: 'playbook_2021', label: '2021', cls: 'l-2021' },
  { id: 'ai_alone', label: 'AI alone', cls: 'l-ai' },
];

function show(v: number | null | undefined, unit: string): string {
  if (v == null) return '—';
  if (unit === '°F') return `${Math.round(v)}°F`;
  if (unit === 'MW') return `${fmt(v)} MW`;
  return compact(v);
}

/** Short axis labels, so "3,000 MW" fits as "3.0K MW". */
function tick(v: number, unit: string): string {
  if (unit === '°F') return `${Math.round(v)}°F`;
  return unit === 'MW' ? `${compact(v)} MW` : compact(v);
}

const when = (iso: string) => {
  const c = gameClock(iso);
  return `${c.label.split(' ')[0]} ${c.time}`;
};

interface Line { key: string; label: string; cls: string; values: (number | null)[] }

/** One line chart with day labels, a value axis, a zero line when values go negative, and a hover readout. */
function Plot({ t, lines, unit, height, hover, onHover, range }: {
  t: string[]; lines: Line[]; unit: string; height: number; hover: number | null; onHover: (i: number | null) => void;
  range: [number, number];
}) {
  const W = 760, H = height, padL = 64, padR = 12, padT = 10, padB = 24;
  const n = t.length;
  const [lo, hi] = range;
  const x = (i: number) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const y = (v: number) => H - padB - ((v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const path = (vs: (number | null)[]) => {
    let d = '', pen = false;
    vs.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const days = t.map((iso, i) => [gameClock(iso), i] as const).filter(([c]) => c.hour === 0);
  const ticks = lo < 0 ? [lo, 0, hi] : [lo, (lo + hi) / 2, hi];
  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    onHover(Math.max(0, Math.min(n - 1, Math.round(((vx - padL) / (W - padL - padR)) * (n - 1)))));
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart explorer-plot" onMouseMove={move} onMouseLeave={() => onHover(null)}
      role="img" aria-label={lines.map((l) => l.label).join(', ')}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className={v === 0 || v === lo ? 'axis' : 'grid'} />
          <text x={padL - 6} y={y(v) + 4} className="tick" textAnchor="end">{tick(v, unit)}</text>
        </g>
      ))}
      {days.map(([c, i]) => <text key={i} x={x(i)} y={H - 7} className="tick" textAnchor="middle">{c.label.split(' ')[0]}</text>)}
      {lines.map((l) => <path key={l.key} d={path(l.values)} className={l.cls} />)}
      {hover != null && (
        <g className="hover">
          <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} />
          {lines.map((l) => l.values[hover] != null && <circle key={l.key} cx={x(hover)} cy={y(l.values[hover]!)} r={3.5} className={l.cls} />)}
        </g>
      )}
    </svg>
  );
}

function niceRange(values: number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  let lo = Math.min(0, ...finite), hi = Math.max(0, ...finite);
  if (hi === lo) hi = lo + 1;
  const step = 10 ** Math.floor(Math.log10(hi - lo));
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

/** Report: pick a measure, compare You, 2021 and the AI together or one chart each, read any hour, download the data. */
export function DataExplorer({ r }: { r: Report }) {
  const ex = r.series;
  const [metricId, setMetricId] = useState(ex?.metrics[0]?.id ?? '');
  const [on, setOn] = useState<Record<Game, boolean>>({ player: true, playbook_2021: true, ai_alone: true });
  const [mode, setMode] = useState<'together' | 'separate'>('together');
  const [hover, setHover] = useState<number | null>(null);
  const metric: Metric | undefined = ex?.metrics.find((m) => m.id === metricId) ?? ex?.metrics[0];

  const csv = useMemo(() => {
    if (!ex) return '';
    const cols: [string, (number | null)[]][] = [];
    for (const m of ex.metrics) {
      if (m.shared) cols.push([m.label, m.shared]);
      else for (const g of GAMES) cols.push([`${m.label} - ${g.label}`, m.by?.[g.id] ?? []]);
    }
    const head = ['time', ...cols.map(([name]) => `"${name}"`)].join(',');
    const rows = ex.t.map((t, i) => [t, ...cols.map(([, vs]) => vs[i] ?? '')].join(','));
    return [head, ...rows].join('\n');
  }, [ex]);

  if (!ex || !metric) return null;
  const games = GAMES.filter((g) => on[g.id]);
  const lines: Line[] = metric.shared
    ? [{ key: 'shared', label: metric.label, cls: 'l-shared', values: metric.shared }]
    : games.map((g) => ({ key: g.id, label: g.label, cls: g.cls, values: metric.by?.[g.id] ?? [] }));
  const reference: Line[] = metric.reference ? [{ key: 'ref', label: metric.reference.label, cls: 'l-ref', values: metric.reference.values }] : [];
  const range = niceRange([...lines, ...reference].flatMap((l) => l.values.filter((v): v is number => v != null)));
  const separate = mode === 'separate' && !metric.shared;
  const stats = lines.map((l) => {
    const vs = l.values.map((v, i) => [v, i] as const).filter(([v]) => v != null) as [number, number][];
    if (!vs.length) return { l, peak: null, peakAt: '', avg: null, last: null };
    const [peak, at] = vs.reduce((a, b) => (b[0] > a[0] ? b : a));
    return { l, peak, peakAt: when(ex.t[at]), avg: vs.reduce((s, [v]) => s + v, 0) / vs.length, last: vs[vs.length - 1][0] };
  });
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `lights-out-${r.storm}-report.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="panel explorer" aria-labelledby="explorer-title">
      <div className="ex-head">
        <span className="ex-title"><span className="tile-ico"><LineIcon size={16} strokeWidth={2.4} /></span><b id="explorer-title">Data explorer</b></span>
        <div className="seg" role="group" aria-label="Chart layout">
          {(['together', 'separate'] as const).map((m) => (
            <button key={m} type="button" className={mode === m ? 'on' : ''} aria-pressed={mode === m} disabled={!!metric.shared && m === 'separate'}
              onClick={() => setMode(m)}>{m === 'together' ? 'Together' : 'Separate'}</button>
          ))}
        </div>
        <button type="button" className="gbtn ex-csv" onClick={download}><Download size={15} strokeWidth={2.5} /> CSV</button>
      </div>
      <div className="ex-tabs" role="tablist" aria-label="Measure">
        {ex.metrics.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={m.id === metric.id} className={m.id === metric.id ? 'on' : ''}
            onClick={() => { setMetricId(m.id); setHover(null); }}>{m.label}</button>
        ))}
      </div>
      {!metric.shared && (
        <div className="ex-games" role="group" aria-label="Games to show">
          {GAMES.map((g) => (
            <button key={g.id} type="button" className={`ex-game ${g.cls}${on[g.id] ? ' on' : ''}`} aria-pressed={on[g.id]}
              onClick={() => setOn({ ...on, [g.id]: !on[g.id] })}><i />{g.label}</button>
          ))}
          {metric.reference && <span className="ex-ref"><i />{metric.reference.label}</span>}
        </div>
      )}
      {lines.length === 0 ? <p className="muted small">Pick at least one game to chart.</p> : separate ? (
        <div className="ex-small">
          {lines.map((l) => (
            <div key={l.key}>
              <span className="ex-small-label">{l.label}</span>
              <Plot t={ex.t} lines={[...reference, l]} unit={metric.unit} height={150} hover={hover} onHover={setHover} range={range} />
            </div>
          ))}
        </div>
      ) : (
        <Plot t={ex.t} lines={[...reference, ...lines]} unit={metric.unit} height={260} hover={hover} onHover={setHover} range={range} />
      )}
      <div className="ex-readout" aria-live="polite">
        {hover == null ? <span className="muted">Point at a chart to read each line at that hour.</span> : (
          <><b>{when(ex.t[hover])}</b>{[...reference, ...lines].map((l) => (
            <span key={l.key} className={`ex-val ${l.cls}`}><i />{l.label}: <b>{show(l.values[hover], metric.unit)}</b></span>
          ))}</>
        )}
      </div>
      <table className="ex-stats">
        <thead><tr><th>{metric.label}</th><th>Peak</th><th>When</th><th>Average</th><th>At the end</th></tr></thead>
        <tbody>
          {stats.map(({ l, peak, peakAt, avg, last }) => (
            <tr key={l.key}><td><i className={`ex-dot ${l.cls}`} />{l.label}</td><td>{show(peak, metric.unit)}</td><td>{peakAt}</td>
              <td>{show(avg, metric.unit)}</td><td>{show(last, metric.unit)}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
