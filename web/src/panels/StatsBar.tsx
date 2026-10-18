import { Star, Thermometer, ZapOff, type LucideIcon } from 'lucide-react';
import { fmt } from '../format';
import { useStore } from '../store';
import { compact } from './hud';

function Stat({ tone, Icon, label, value, title }: { tone: string; Icon: LucideIcon; label: string; value: string; title: string }) {
  return (
    <div className={`panel stat ${tone}`} title={title}>
      <div className="stat-top">
        <span className="stat-ico" aria-hidden="true"><Icon size={15} strokeWidth={2.5} /></span>
        <b>{value}</b>
      </div>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function StatsBar() {
  const noPower = useStore((s) => s.state?.totals.people_no_power ?? 0);
  const cold = useStore((s) => s.state?.totals.people_cold ?? 0);
  const points = useStore((s) => s.state?.points ?? 0);
  return (
    <div className="stats-bar pop" role="group" aria-label="County status">
      <Stat tone="power" Icon={ZapOff} label="Without power" value={compact(noPower)} title={`${fmt(noPower)} people without power`} />
      <Stat tone="cold" Icon={Thermometer} label="Cold homes" value={compact(cold)} title={`${fmt(cold)} people in homes below 50°F`} />
      <Stat tone="pts" Icon={Star} label="Emergency pts" value={String(points)} title={`${points} emergency points to spend`} />
    </div>
  );
}
