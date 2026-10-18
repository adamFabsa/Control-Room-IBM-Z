import { Check, Flame, Megaphone, UtilityPole, Zap } from 'lucide-react';
import { useStore } from '../store';
import { fmt } from '../format';

export function OrderBar() {
  const order = useStore((s) => s.state?.order_mw ?? 0);
  const cut = useStore((s) => s.state?.cut_mw ?? 0);
  const gas = useStore((s) => s.state?.effects?.gas_multiplier ?? 1);
  const conservation = useStore((s) => !!s.state?.effects?.conservation);
  const ghost = useStore((s) => {
    const h = s.ui.hover;
    if (!h || !s.state) return 0;
    const id = h.kind === 'circuit' ? h.id : h.circuit;
    const c = s.state.circuits.find((x) => x.id === id);
    if (!c || c.protected) return 0;
    if (s.ui.tool === 'cut' && c.on) return c.mw;
    if (s.ui.tool === 'restore' && !c.on) return -c.mw;
    return 0;
  });

  if (order <= 0) {
    return (
      <div className="panel order-bar calm pop">
        <div className="ob-top">
          <span className="ob-icon" aria-hidden="true"><UtilityPole size={24} strokeWidth={2.2} /></span>
          <div className="ob-text">
            <span className="ob-eyebrow">Grid operator</span>
            <div className="ob-headline">No cut order right now</div>
            <div className="ob-calm">{cut > 0 ? `${fmt(cut)} MW still cut. Restore when you can.` : 'Every neighborhood has power.'}</div>
          </div>
        </div>
      </div>
    );
  }

  const max = Math.max(order * 1.3, cut + Math.max(0, ghost));
  const diff = cut - order;
  const met = Math.abs(diff) <= order * 0.05;
  const after = cut + ghost - order;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const tone = met ? 'met' : diff < 0 ? 'short' : 'over';

  return (
    <div className={`panel order-bar ${tone} pop`}>
      <div className="ob-top">
        <span className="ob-icon" aria-hidden="true"><Zap size={24} strokeWidth={2.2} fill="currentColor" fillOpacity={0.25} /></span>
        <div className="ob-text">
          <span className="ob-eyebrow">Grid operator order</span>
          <div className="ob-headline">Cut <span className="num">{fmt(order)}</span> MW now</div>
        </div>
        <div className="ob-cut">
          <b>{fmt(cut)}</b>
          <span>MW cut</span>
        </div>
      </div>
      <div
        className="gauge"
        role="meter"
        aria-label="Power cut against the order"
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(cut)}
        aria-valuetext={`${fmt(cut)} of ${fmt(order)} MW`}
      >
        <div className="gauge-track">
          <i className="fill" style={{ width: pct(cut) }} />
          {ghost !== 0 && <i className="ghost" style={{ left: pct(Math.min(cut, cut + ghost)), width: pct(Math.abs(ghost)) }} />}
        </div>
        <span className="notch" style={{ left: pct(order) }}>
          <span className="notch-label">{fmt(order)}</span>
        </span>
      </div>
      <div className="ob-status">
        <span className={`status-pill ${tone}`}>
          {met ? <><Check size={14} strokeWidth={3} /> Order met</> : diff < 0 ? `Short by ${fmt(-diff)} MW` : `Over by ${fmt(diff)} MW`}
        </span>
        {ghost !== 0 && (
          <span className="ob-preview">
            This click: <b>{ghost > 0 ? '+' : '−'}{fmt(Math.abs(ghost))} MW</b> → {after >= 0 ? `over by ${fmt(after)}` : `short by ${fmt(-after)}`}
          </span>
        )}
        {gas > 1 && <span className="chip warn"><Flame size={12} strokeWidth={2.6} /> Gas ×{gas.toFixed(2)}</span>}
        {conservation && <span className="chip"><Megaphone size={12} strokeWidth={2.6} /> Conservation on</span>}
      </div>
    </div>
  );
}
