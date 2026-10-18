import { Bot, CalendarClock, ClipboardList, FlaskConical, HeartPulse, RotateCcw, Trophy, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Report } from '../contracts';
import { fmt, gameClock } from '../format';
import { compact } from '../panels/hud';
import { useStore } from '../store';

function mockReport(player: number): Report {
  const hours = Array.from({ length: 115 }, (_, i) => i);
  const bump = (h: number, k: number) => Math.max(0, Math.sin(Math.min(Math.PI, ((h - 7) / 90) * Math.PI))) * k;
  return {
    storm: 'uri2021',
    beat_playbook: true,
    scores: {
      playbook_2021: { cold_person_hours: Math.max(player * 2.6, 1_900_000) },
      ai_alone: { cold_person_hours: Math.max(player * 1.1, 700_000) },
      player: { cold_person_hours: player },
    },
    cold_people_by_hour: {
      t: hours.map(String),
      playbook_2021: hours.map((h) => bump(h, 900_000)),
      ai_alone: hours.map((h) => bump(h, 420_000)),
      player: hours.map((h) => bump(h, 360_000)),
    },
    summary: 'Mock report. The analyst text comes from Granite on LinuxONE once the server is connected.',
    plan: ['Give every water plant backup power.', 'Never leave a neighborhood dark more than 4 hours.', 'Open warming centers before the first freeze.'],
  };
}

/** Round a chart's top up to 1, 2 or 5 times a power of ten. */
function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

type Series = NonNullable<Report['cold_people_by_hour']>;

function Chart({ s, what }: { s?: Series; what: string }) {
  if (!s || s.t.length < 2) return null;
  const W = 640, H = 230, padL = 44, padR = 12, padT = 10, padB = 26;
  const n = s.t.length; // every line starts at the storm's first hour; a collapsed game's line just ends early
  const max = niceMax(Math.max(...s.playbook_2021, ...s.ai_alone, ...s.player, 1));
  const x = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v: number) => H - padB - (v / max) * (H - padT - padB);
  const path = (ys: number[]) => ys.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  // a day label at each midnight in the real timestamps (the mock report has plain hour numbers instead)
  const real = !Number.isNaN(Date.parse(s.t[0]));
  const midnights: [string, number][] = real
    ? s.t.map((t, i) => [gameClock(t), i] as const).filter(([c]) => c.hour === 0).map(([c, i]) => [c.label.split(' ')[0], i])
    : [['Mon', 6], ['Tue', 30], ['Wed', 54], ['Thu', 78], ['Fri', 102]];
  // label the start too, unless the first midnight is close enough that the two would overlap
  const first = real ? gameClock(s.t[0]).label.split(' ')[0] : 'Sun';
  const days: [string, number][] = (midnights[0]?.[1] ?? n) >= n * 0.09 ? [[first, 0], ...midnights] : midnights;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`${what} each hour; top of the scale ${fmt(max)}`}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} className={f ? 'grid' : 'axis'} />
          <text x={padL - 6} y={y(max * f) + 4} className="tick" textAnchor="end">{compact(max * f)}</text>
        </g>
      ))}
      {days.map(([d, i]) => (
        <text key={`${d}${i}`} x={x(i)} y={H - 8} className="tick" textAnchor={i === 0 ? 'start' : 'middle'}>{d}</text>
      ))}
      <path d={path(s.playbook_2021)} className="l-2021" />
      <path d={path(s.ai_alone)} className="l-ai" />
      <path d={path(s.player)} className="l-you" />
    </svg>
  );
}

/** The DSHS-anchored estimate of deaths, big, next to 2021's confirmed count. */
function Deaths({ r }: { r: Report }) {
  const d = r.estimated_deaths;
  if (!d) return null;
  const diff = d.player == null ? null : d.player - d.playbook_2021;
  return (
    <section className="panel deaths" aria-labelledby="deaths-title">
      <div className="deaths-main">
        <span className="deaths-ico" aria-hidden="true"><HeartPulse size={22} strokeWidth={2.3} /></span>
        <div>
          <span className="deaths-eyebrow" id="deaths-title">Estimated deaths in Dallas County</span>
          <b className="deaths-you">{d.player == null ? 'Grid collapsed' : `≈ ${fmt(d.player)}`}</b>
          <span className={`deaths-diff ${diff == null ? 'bad' : diff < 0 ? 'good' : diff > 0 ? 'bad' : ''}`}>
            {diff == null ? 'A countywide blackout: no estimate covers it'
              : diff === 0 ? 'About the same as in 2021'
              : `About ${fmt(Math.abs(diff))} ${diff < 0 ? 'fewer' : 'more'} than in 2021`}
          </span>
        </div>
      </div>
      <div className="deaths-side"><b>{fmt(d.playbook_2021)}</b><span>confirmed in 2021<br />(Texas DSHS)</span></div>
      <div className="deaths-side ai"><b>{d.ai_alone == null ? '—' : `≈ ${fmt(d.ai_alone)}`}</b><span>with the AI<br />playing alone</span></div>
      <p className="deaths-note">{d.method} <a href={d.source_url} target="_blank" rel="noreferrer">{d.source}</a></p>
    </section>
  );
}

/** You, 2021 and the AI side by side on every outcome the game scores. */
function Outcomes({ r }: { r: Report }) {
  const sc = r.scores, d = r.estimated_deaths;
  const hours = (m?: number) => (m ?? 0) / 60;
  const rows: { label: string; vals: (number | null | undefined)[]; show: (v: number) => string }[] = [
    { label: 'Estimated deaths', vals: [d?.playbook_2021, d?.ai_alone, d?.player], show: (v) => fmt(v) },
    { label: 'Hours in cold homes', vals: [sc.playbook_2021.cold_person_hours, sc.ai_alone.cold_person_hours, sc.player.cold_person_hours], show: compact },
    { label: 'Longest outage', vals: [hours(sc.playbook_2021.longest_outage_min), hours(sc.ai_alone.longest_outage_min), hours(sc.player.longest_outage_min)], show: (v) => `${Math.round(v)} h` },
    { label: 'Critical buildings dark', vals: [hours(sc.playbook_2021.critical_dark_min), hours(sc.ai_alone.critical_dark_min), hours(sc.player.critical_dark_min)], show: (v) => `${Math.round(v)} h` },
    { label: 'People-hours under boil-water notice', vals: [sc.playbook_2021.boil_water_person_hours, sc.ai_alone.boil_water_person_hours, sc.player.boil_water_person_hours], show: compact },
  ];
  const who = ['2021', 'AI alone', 'You'];
  return (
    <div className="panel outcomes">
      <div className="chart-head"><b>Your decisions against 2021</b>
        <span className="legend"><i className="k-2021" />2021 <i className="k-ai" />AI alone <i className="k-you" />You</span></div>
      {rows.map((row) => {
        const max = Math.max(...row.vals.map((v) => v ?? 0), 1e-9);
        return (
          <div className="oc-row" key={row.label}>
            <span className="oc-label">{row.label}</span>
            {row.vals.map((v, i) => (
              <div className={`oc-bar b${i}`} key={who[i]} title={`${who[i]}: ${v == null ? 'no estimate' : row.show(v)}`}>
                <i style={{ width: `${v == null ? 0 : Math.max(1.5, (v / max) * 100)}%` }} />
                <span>{v == null ? '—' : row.show(v)}</span>
              </div>
            ))}
          </div>
        );
      })}
      <small className="muted">Lower is better on every line.</small>
    </div>
  );
}

/** "saved 92.1M cold person-hours", or what a collapse meant. */
function tpEffect(tp: NonNullable<Report['turning_points']>[number]): string {
  if (tp.grid_collapsed_without && !tp.grid_collapsed) return 'kept the grid from collapsing';
  if (tp.grid_collapsed && !tp.grid_collapsed_without) return 'led to the grid collapse';
  const c = tp.cold_person_hours_change ?? -tp.delta_cold_person_hours;
  return `${c > 0 ? 'saved' : 'cost'} ${compact(Math.abs(c))} cold person-hours`;
}

export function ReportScreen() {
  const linkKind = useStore((s) => s.linkKind);
  const send = useStore((s) => s.send);
  const cph = useStore((s) => s.state?.totals.cold_person_hours ?? 0);
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    if (linkKind === 'mock') { setReport(mockReport(cph)); return; }
    // The server fills in the AI analyst's tip and the 1,000-storm test over about 2 minutes: re-fetch until done.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => fetch('/api/report').then((r) => r.json()).then((r: Report) => {
      if (stopped) return;
      setReport(r);
      if (!r.stress_test) timer = setTimeout(load, 4000);
    }).catch(() => { if (!stopped) setReport(mockReport(cph)); });
    load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [linkKind, cph]);

  if (!report) return <div className="report-wrap"><div className="panel report">Loading the report…</div></div>;
  const sc = report.scores;
  const M = (v: number) => `${(v / 1e6).toFixed(2)}M`;
  return (
    <div className="report-wrap">
      <div className="report pop">
        <div className="report-hero">
          {report.beat_playbook && <span className="report-trophy" aria-hidden="true"><Trophy size={30} strokeWidth={2.2} /></span>}
          <span className="report-eyebrow">Storm over · Winter Storm Uri · Dallas County</span>
          <h1>{report.beat_playbook ? 'You beat the 2021 playbook.' : 'The 2021 playbook did better this time.'}</h1>
          <p>Same storm, same power shortage. You chose who went dark.</p>
          <button type="button" className="gbtn ice play-again" onClick={() => send({ type: 'new_game' })}>
            <RotateCcw size={18} strokeWidth={2.6} /> Play again
          </button>
        </div>
        <Deaths r={report} />
        <div className="tiles">
          <div className="panel tile y2021"><span className="tile-head"><span className="tile-ico"><CalendarClock size={18} strokeWidth={2.4} /></span>What happened in 2021</span><b>{M(sc.playbook_2021.cold_person_hours)}</b><small>hours people spent in cold homes</small></div>
          <div className="panel tile ai"><span className="tile-head"><span className="tile-ico"><Bot size={18} strokeWidth={2.4} /></span>AI playing alone</span><b>{M(sc.ai_alone.cold_person_hours)}</b><small>hours people spent in cold homes</small></div>
          <div className="panel tile you"><span className="tile-head"><span className="tile-ico"><UserRound size={18} strokeWidth={2.4} /></span>You + AI co-pilot</span><b>{M(sc.player.cold_person_hours)}</b><small>hours people spent in cold homes</small></div>
        </div>
        <div className="report-row">
          <div className="panel chart-box">
            <div className="chart-head"><b>People in cold homes, day by day</b>
              <span className="legend"><i className="k-2021" />2021 <i className="k-ai" />AI alone <i className="k-you" />You</span></div>
            <Chart s={report.cold_people_by_hour} what="People in cold homes" />
            {report.game_check && <small className="muted">Game check: {report.game_check}</small>}
            {!!report.turning_points?.length && (
              <div className="turning">
                <b>Your turning points</b>
                <ol>
                  {report.turning_points.map((tp, i) => (
                    <li key={i}><span>{tp.label ?? tp.action.type}</span><small className={(tp.cold_person_hours_change ?? 0) > 0 || tp.grid_collapsed_without ? 'good' : 'bad'}>{tpEffect(tp)}</small></li>
                  ))}
                </ol>
                {report.turning_points_run && (
                  <small className="muted">Found by replaying your storm {fmt(report.turning_points_run.replays)} times, once without each decision, on {report.turning_points_run.cores} LinuxONE cores in {report.turning_points_run.seconds.toFixed(1)} s.</small>
                )}
              </div>
            )}

          </div>
          <div className="panel analyst">
            <span className="analyst-head"><span className="tile-ico"><Bot size={17} strokeWidth={2.4} /></span>AI analyst</span>
            <p>{report.summary ?? 'Reading your storm…'}</p>
          </div>
        </div>
        <div className="report-row even">
          <div className="report-col">
            <div className="panel chart-box">
              <div className="chart-head"><b>People without power, day by day</b>
                <span className="legend"><i className="k-2021" />2021 <i className="k-ai" />AI alone <i className="k-you" />You</span></div>
              <Chart s={report.no_power_by_hour} what="People without power" />
            </div>
            <div className="panel plan-box">
              <div className="plan">
                <span className="plan-head"><span className="tile-ico"><ClipboardList size={16} strokeWidth={2.4} /></span>Your plan for next winter</span>
                {report.plan?.length
                ? <ol>{report.plan.map((p) => <li key={p}>{p}</li>)}</ol>
                : <p className="muted small">You bought nothing in Get ready. Try a generator at the water plant next time.</p>}
              </div>
              {report.stress_test ? (
                <div className="stress"><span><FlaskConical size={14} strokeWidth={2.4} /> Tested on {fmt(report.stress_test.storms)} new storms</span><b>Works in {fmt(report.stress_test.works)}</b><small>{report.stress_test.worst}{report.stress_test.seconds ? ` · ran in ${Math.round(report.stress_test.seconds)} s on ${report.stress_test.cores} LinuxONE cores` : ''}</small></div>
              ) : (
                <div className="stress"><span><FlaskConical size={14} strokeWidth={2.4} /> 1,000-storm stress test</span>
                  <b>{report.stress_test_progress?.status === 'running' ? `Testing… ${fmt(report.stress_test_progress.done ?? 0)} of ${fmt(report.stress_test_progress.storms ?? 1000)}` : 'Runs on LinuxONE'}</b>
                  <small>Your plan on storms generated from real Dallas cold spells (2005–2026), against the 2021 playbook</small></div>
              )}
            </div>
          </div>
          <Outcomes r={report} />
        </div>
        {linkKind === 'mock' && <p className="center muted small">Mock numbers for the screen. The real report comes from GET /api/report.</p>}
      </div>
    </div>
  );
}
