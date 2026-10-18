import { ArrowRight, Check, Flame, Heater, Megaphone, MousePointerClick, PlugZap, Shield, Snowflake, Star, ToggleRight, Wrench, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { BuyItem, GameState } from '../contracts';
import { mapControls } from '../map/controls';
import { CameraWidget } from '../panels/CameraWidget';
import { PlanList } from '../panels/PlanList';
import { TimeWidget } from '../panels/TimeWidget';
import { useStore } from '../store';
import { useMapKeys } from './StormScreen';

interface Item { id: BuyItem; name: string; cost: number; Icon: LucideIcon; color: string; text: string; target: 'circuit' | 'building' | 'auto' }

const ITEMS: Item[] = [
  { id: 'protect', name: 'Protect', cost: 1, Icon: Shield, color: 'var(--shield)', target: 'circuit', text: "This neighborhood can't be cut, and its power can't count toward the order. Click a neighborhood." },
  { id: 'generator', name: 'Generator', cost: 2, Icon: PlugZap, color: 'var(--window)', target: 'building', text: 'Keeps one building running when its circuit is cut. 48 hours of fuel. Click a building.' },
  { id: 'warming_center', name: 'Warming center', cost: 1, Icon: Heater, color: 'var(--cold)', target: 'auto', text: 'Opens the South Dallas school. Up to 20,000 people from dark homes nearby stay warm.' },
  { id: 'keep_gas', name: 'Keep gas flowing', cost: 2, Icon: Flame, color: 'var(--amber)', target: 'auto', text: 'The gas compressor stays on even if West Dallas is cut, so the power plant keeps its fuel.' },
  { id: 'conservation', name: 'Conservation alert', cost: 1, Icon: Megaphone, color: 'var(--ice)', target: 'auto', text: 'Asks people to use less power. Cut orders drop 3% for the first 24 hours.' },
  { id: 'repair_crews', name: 'Repair crews', cost: 1, Icon: Wrench, color: 'var(--good)', target: 'auto', text: 'Lines broken by ice are fixed in 2 hours instead of 6.' },
  { id: 'smart_switch', name: 'Smart switches', cost: 2, Icon: ToggleRight, color: '#b9a4ff', target: 'circuit', text: 'Splits a neighborhood in two, so you can cut one half and keep the other on. Click a neighborhood.' },
];

function placed(item: BuyItem, s: GameState): number {
  switch (item) {
    case 'protect': return s.circuits.filter((c) => c.protected).length;
    case 'smart_switch': return s.circuits.filter((c) => c.split).length;
    case 'generator': return s.buildings.filter((b) => b.generator).length;
    case 'warming_center': return s.prep?.warming_center ? 1 : 0;
    case 'keep_gas': return s.prep?.keep_gas ? 1 : 0;
    case 'conservation': return s.prep?.conservation ? 1 : 0;
    case 'repair_crews': return s.prep?.repair_crews ? 1 : 0;
  }
}

const pts = (n: number) => `${n} pt${n === 1 ? '' : 's'}`;

export function ReadyScreen() {
  useMapKeys();
  const state = useStore((s) => s.state);
  const ui = useStore((s) => s.ui);
  const setUI = useStore((s) => s.setUI);
  const send = useStore((s) => s.send);
  if (!state || ui.hidePanels) return null;
  const points = state.points;
  const active = ITEMS.find((i) => i.id === ui.buyItem) ?? null;

  const choose = (it: Item) => {
    if (it.target === 'auto') {
      const has = placed(it.id, state) > 0;
      if (!has && points < it.cost) return;
      const target = it.id === 'warming_center' ? 'school-1' : it.id === 'keep_gas' ? 'gas-1' : 'county';
      send({ type: has ? 'sell' : 'buy', item: it.id, target });
      if (it.id === 'warming_center') mapControls.focus('school-1', 1.5);
      if (it.id === 'keep_gas') mapControls.focus('gas-1', 1.5);
      setUI({ buyItem: it.id, tool: 'inspect' });
      return;
    }
    const same = ui.buyItem === it.id && ui.tool === 'buy';
    setUI({ buyItem: same ? null : it.id, tool: same ? 'inspect' : 'buy' });
  };

  return (
    <div className="hud ready">
      <div className="slot top-left"><TimeWidget compact /></div>
      <div className="slot top-center">
        <div className="panel ready-head pop">
          <span className="rh-icon" aria-hidden="true"><Snowflake size={26} strokeWidth={2.2} /></span>
          <div className="rh-text">
            <h1>The storm hits in 3 days</h1>
            <p>Spend your points to get the county ready.</p>
          </div>
        </div>
      </div>
      <div className="slot right"><PlanList /></div>
      <div className="slot bottom-left"><CameraWidget /></div>
      <div className="slot bottom-center ready-bottom">
        <div className="ready-row">
          {active ? (
            <div className="panel explainer pop" key={active.id} style={{ '--c': active.color } as CSSProperties}>
              <span className="ex-ico" aria-hidden="true"><active.Icon size={20} strokeWidth={2.3} /></span>
              <div className="ex-text">
                <b>{active.name} <span className="cost-pill"><Star size={10} strokeWidth={3} fill="currentColor" />{pts(active.cost)}</span></b>
                <span>{active.text}</span>
              </div>
            </div>
          ) : (
            <div className="panel explainer idle pop" key="idle">
              <span className="ex-ico" aria-hidden="true"><MousePointerClick size={20} strokeWidth={2.3} /></span>
              <div className="ex-text">
                <b>Get the county ready</b>
                <span>Pick an item, then click the map to place it. Click a placed item again to take it back.</span>
              </div>
            </div>
          )}
          <button
            type="button"
            className="gbtn ice start-btn"
            onClick={() => { setUI({ buyItem: null, tool: 'inspect', selected: null }); send({ type: 'start_storm' }); }}
          >
            Start the storm <ArrowRight size={22} strokeWidth={2.6} />
          </button>
        </div>
        <div className="panel catalog" role="toolbar" aria-label="Get-ready items">
          <div className="points" aria-label={`${points} of 10 points left`}>
            <span className="points-label">Points left</span>
            <span className="points-num">
              <span className="coin" aria-hidden="true"><Star size={14} strokeWidth={2.6} fill="currentColor" /></span>
              <b>{points}</b>
              <small>/10</small>
            </span>
          </div>
          <span className="dock-sep" aria-hidden="true" />
          {ITEMS.map((it) => {
            const n = placed(it.id, state);
            const on = ui.buyItem === it.id;
            return (
              <button
                key={it.id}
                type="button"
                className={`gbtn item${on ? ' on' : ''}${n ? ' owned' : ''}`}
                style={{ '--c': it.color } as CSSProperties}
                disabled={points < it.cost && n === 0 && it.target === 'auto'}
                aria-pressed={on}
                aria-label={`${it.name}, ${pts(it.cost)}${n ? `, ${it.target === 'auto' ? 'bought' : `${n} placed`}` : ''}`}
                onClick={() => choose(it)}
              >
                <span className="item-ico"><it.Icon size={20} strokeWidth={2.3} /></span>
                <span className="item-name">{it.name}</span>
                <span className="cost-pill"><Star size={9} strokeWidth={3} fill="currentColor" />{it.cost}</span>
                {n > 0 && <span className="owned-badge">{it.target === 'auto' ? <Check size={13} strokeWidth={3.4} /> : `×${n}`}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
