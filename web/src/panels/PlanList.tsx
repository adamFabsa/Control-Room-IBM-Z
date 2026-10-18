import { ClipboardList, Flame, Heater, Megaphone, PlugZap, Shield, Star, ToggleRight, Wrench, X, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Action, GameState } from '../contracts';
import { mapControls } from '../map/controls';
import { BUILDING_BY_ID } from '../map/layout';
import { useStore } from '../store';

export interface Entry { key: string; Icon: LucideIcon; color: string; name: string; where: string; cost: number; sell: Action; focus?: string }

/** Everything placed (in Get ready, plus emergency buys in the storm), read from the game state so it always
 *  matches the server. `focus` is the building or circuit it sits on; county-wide items have none. */
export function planEntries(s: GameState): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const c of s.circuits) {
    const id = c.parent ?? c.id;
    if (c.protected && !seen.has(`p${id}`)) {
      seen.add(`p${id}`);
      out.push({ key: `protect-${id}`, Icon: Shield, color: 'var(--shield)', name: 'Protected', where: `${c.area} · ${id}`, cost: 1,
        sell: { type: 'sell', item: 'protect', target: id }, focus: id });
    }
    if (c.parent && !seen.has(`s${id}`)) {
      seen.add(`s${id}`);
      out.push({ key: `switch-${id}`, Icon: ToggleRight, color: '#b9a4ff', name: 'Smart switches', where: `${c.area} · ${id}`, cost: 2,
        sell: { type: 'sell', item: 'smart_switch', target: id }, focus: id });
    }
  }
  for (const b of s.buildings) {
    if (b.generator) {
      out.push({ key: `gen-${b.id}`, Icon: PlugZap, color: 'var(--window)', name: 'Generator', where: BUILDING_BY_ID[b.id]?.name ?? b.id, cost: 2,
        sell: { type: 'sell', item: 'generator', target: b.id }, focus: b.id });
    }
  }
  const centers = s.warming_centers?.length ?? (s.prep?.warming_center ? 1 : 0);
  for (let i = 0; i < centers; i++) {
    out.push({ key: `warm-${i}`, Icon: Heater, color: 'var(--cold)', name: 'Warming center', where: 'South Dallas school', cost: 1,
      sell: { type: 'sell', item: 'warming_center', target: 'school-1' }, focus: 'school-1' });
  }
  if (s.prep?.keep_gas) {
    out.push({ key: 'gas', Icon: Flame, color: 'var(--amber)', name: 'Gas kept flowing', where: 'West Dallas compressor station', cost: 2,
      sell: { type: 'sell', item: 'keep_gas', target: 'gas-1' }, focus: 'gas-1' });
  }
  if (s.prep?.conservation) {
    out.push({ key: 'cons', Icon: Megaphone, color: 'var(--ice)', name: 'Conservation alert', where: 'Whole county · first 24 hours', cost: 1,
      sell: { type: 'sell', item: 'conservation', target: 'county' } });
  }
  if (s.prep?.repair_crews) {
    out.push({ key: 'crews', Icon: Wrench, color: 'var(--good)', name: 'Repair crews', where: 'On standby for iced lines', cost: 1,
      sell: { type: 'sell', item: 'repair_crews', target: 'county' } });
  }
  return out;
}

/** Get ready: the list of what's placed and where, with a button to take each back. */
export function PlanList() {
  const state = useStore((s) => s.state);
  const send = useStore((s) => s.send);
  if (!state) return null;
  const entries = planEntries(state);
  return (
    <section className="panel plan-list pop" aria-labelledby="plan-list-title">
      <header className="pl-head">
        <span className="pl-head-ico" aria-hidden="true"><ClipboardList size={17} strokeWidth={2.4} /></span>
        <b id="plan-list-title">Your preparations</b>
        <span className="pl-spent"><Star size={11} strokeWidth={3} fill="currentColor" />{10 - state.points} of 10 spent</span>
      </header>
      {entries.length === 0 ? (
        <p className="pl-empty">Nothing placed yet. Pick an item below, then click the map to place it.</p>
      ) : (
        <ul className="pl-items">
          {entries.map((e) => (
            <li key={e.key} style={{ '--c': e.color } as CSSProperties}>
              <button type="button" className="pl-row" disabled={!e.focus} title={e.focus ? 'Show on the map' : undefined}
                onClick={() => e.focus && mapControls.focus(e.focus, 2.2)}>
                <span className="pl-ico" aria-hidden="true"><e.Icon size={16} strokeWidth={2.4} /></span>
                <span className="pl-text"><b>{e.name}</b><small>{e.where}</small></span>
                <span className="cost-pill"><Star size={9} strokeWidth={3} fill="currentColor" />{e.cost}</span>
              </button>
              <button type="button" className="pl-x" aria-label={`Take back: ${e.name}, ${e.where}`} title="Take it back" onClick={() => send(e.sell)}>
                <X size={14} strokeWidth={2.8} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
