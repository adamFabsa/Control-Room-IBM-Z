import { Bot, CalendarClock, ClipboardList, FlaskConical, Sparkles, Trophy, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Report } from '../contracts';
import { fmt } from '../format';
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

function Chart({ r }: { r: Report }) {
  const s = r.cold_people_by_hour;
  if (!s) return null;
  const W = 640, H = 220, pad = 28;
  const n = s.player.length;
  const max = Math.max(...s.playbook_2021, ...s.ai_alone, ...s.player, 1);
  const path = (ys: number[]) => ys.map((y, i) => `${i ? 'L' : 'M'}${(pad + (i / (n - 1)) * (W - pad * 2)).toFixed(1)},${(H - pad - (y / max) * (H - pad * 2)).toFixed(1)}`).join('');
  // the storm starts Sun 18:00, so midnights fall at hours 6, 30, 54, 78, 102
  const days: [string, number][] = [['Sun', 0], ['Mon', 6], ['Tue', 30], ['Wed', 54], ['Thu', 78], ['Fri', 102]];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="People in cold homes by day">
      <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} className="axis" />
      {days.map(([d, h]) => (
        <text key={d} x={pad + (h / (n - 1)) * (W - pad * 2)} y={H - 8} className="tick">{d}</text>
      ))}
      <path d={path(s.playbook_2021)} className="l-2021" />
      <path d={path(s.ai_alone)} className="l-ai" />
      <path d={path(s.player)} className="l-you" />
    </svg>
  );
}

export function ReportScreen() {
  const linkKind = useStore((s) => s.linkKind);
  const cph = useStore((s) => s.state?.totals.cold_person_hours ?? 0);
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    if (linkKind === 'mock') { setReport(mockReport(cph)); return; }
    fetch('/api/report').then((r) => r.json()).then(setReport).catch(() => setReport(mockReport(cph)));
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
        </div>
        <div className="tiles">
          <div className="panel tile y2021"><span className="tile-head"><span className="tile-ico"><CalendarClock size={18} strokeWidth={2.4} /></span>What happened in 2021</span><b>{M(sc.playbook_2021.cold_person_hours)}</b><small>hours people spent in cold homes</small></div>
          <div className="panel tile ai"><span className="tile-head"><span className="tile-ico"><Bot size={18} strokeWidth={2.4} /></span>AI playing alone</span><b>{M(sc.ai_alone.cold_person_hours)}</b><small>hours people spent in cold homes</small></div>
          <div className="panel tile you"><span className="tile-head"><span className="tile-ico"><UserRound size={18} strokeWidth={2.4} /></span>You + AI co-pilot</span><b>{M(sc.player.cold_person_hours)}</b><small>hours people spent in cold homes</small></div>
        </div>
        <div className="report-row">
          <div className="panel chart-box">
            <div className="chart-head"><b>People in cold homes, day by day</b>
              <span className="legend"><i className="k-2021" />2021 <i className="k-ai" />AI alone <i className="k-you" />You</span></div>
            <Chart r={report} />
            {report.game_check && <small className="muted">Game check: {report.game_check}</small>}
          </div>
          <div className="panel analyst">
            <span className="analyst-head"><span className="tile-ico"><Sparkles size={16} strokeWidth={2.4} /></span>AI analyst</span>
            <p>{report.summary}</p>
          </div>
        </div>
        <div className="panel plan-box">
          <div className="plan">
            <span className="plan-head"><span className="tile-ico"><ClipboardList size={16} strokeWidth={2.4} /></span>Your plan for next winter</span>
            <ol>{report.plan?.map((p) => <li key={p}>{p}</li>)}</ol>
          </div>
          {report.stress_test ? (
            <div className="stress"><span><FlaskConical size={14} strokeWidth={2.4} /> Tested on {fmt(report.stress_test.storms)} new storms</span><b>Works in {fmt(report.stress_test.works)}</b><small>{report.stress_test.worst}</small></div>
          ) : (
            <div className="stress"><span><FlaskConical size={14} strokeWidth={2.4} /> 1,000-storm stress test</span><b>Runs on LinuxONE</b><small>Results appear here from the server</small></div>
          )}
        </div>
        {linkKind === 'mock' && <p className="center muted small">Mock numbers for the screen. The real report comes from GET /api/report.</p>}
      </div>
    </div>
  );
}
