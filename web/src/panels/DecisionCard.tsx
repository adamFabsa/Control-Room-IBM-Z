import { AlertTriangle, Sparkles } from 'lucide-react';
import type { EventOption } from '../contracts';
import { useStore } from '../store';
import { compact } from './hud';

/** M2's forecast for one option, in a few words. */
function m2Words(m: NonNullable<EventOption['m2']>): string {
  if (m.grid_collapse_risk) return 'risks a grid collapse within 6 hours';
  const c = Math.round(m.cold_person_hours_change);
  const effect = c < 0 ? `saves ${compact(-c)}` : c > 0 ? `adds ${compact(c)}` : 'no change in';
  const risk = m.critical_dark_chance >= 0.15 ? ` · ${Math.round(m.critical_dark_chance * 100)}% risk a critical building goes dark` : '';
  return `${effect} cold person-hours${risk}`;
}

export function DecisionCard() {
  const ev = useStore((s) => s.state?.event);
  const highlight = useStore((s) => s.ui.highlight);
  const send = useStore((s) => s.send);
  const setUI = useStore((s) => s.setUI);
  if (!ev) return null;
  return (
    <div className="panel decision-card pop" role="dialog" aria-labelledby="ev-title" aria-describedby={ev.text ? 'ev-text' : undefined} key={ev.id}>
      <div className="dc-strip">
        <AlertTriangle size={16} strokeWidth={2.6} />
        <span>Decision</span>
        <span className="dc-dot" aria-hidden="true">·</span>
        <span className="dc-paused">game paused</span>
      </div>
      <div className="dc-body">
        <h2 id="ev-title">{ev.title}</h2>
        {ev.text && <p id="ev-text">{ev.text}</p>}
        {ev.ai_text && (
          <p className="dc-ai"><Sparkles size={13} strokeWidth={2.6} aria-hidden="true" /><span><b>Granite on LinuxONE:</b> {ev.ai_text}</span></p>
        )}
        <div className="options">
          {ev.options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              className={`option${i === highlight ? ' hl' : ''}${o.ai_pick ? ' ai' : ''}`}
              onMouseEnter={() => setUI({ highlight: i })}
              onFocus={() => setUI({ highlight: i })}
              onClick={() => send({ type: 'choose', event: ev.id, option: o.id })}
            >
              <span className="radio" aria-hidden="true" />
              <span className="opt-label">
                {o.label}
                {o.m2 && <small className="opt-m2" title="M2 what-if model (Snap ML on LinuxONE), next 6 game hours">M2: {m2Words(o.m2)}</small>}
              </span>
              {o.ai_pick && <span className="ai-badge"><Sparkles size={12} strokeWidth={2.6} /> AI PICK</span>}
            </button>
          ))}
        </div>
        <div className="dc-hint"><kbd>↑</kbd><kbd>↓</kbd> choose <span className="sep" /> <kbd>Enter</kbd> confirm</div>
      </div>
    </div>
  );
}
