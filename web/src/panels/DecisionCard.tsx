import { AlertTriangle, Bot } from 'lucide-react';
import type { EventOption } from '../contracts';
import { useStore } from '../store';
import { compact } from './hud';

const M2_TITLE = 'M2 what-if model (Snap ML on LinuxONE): what this choice does over the next 6 game hours';

/** M2's forecast for one option as one or two short chips: the change in cold person-hours, and a risk if any. */
function M2Chips({ m }: { m: NonNullable<EventOption['m2']> }) {
  const c = Math.round(m.cold_person_hours_change);
  const risk = m.critical_dark_chance >= 0.15 ? Math.round(m.critical_dark_chance * 100) : 0;
  return (
    <span className="opt-chips" title={M2_TITLE}>
      {m.grid_collapse_risk ? <span className="m2-chip bad">Grid collapse risk</span>
        : c !== 0 && <span className={`m2-chip ${c < 0 ? 'good' : 'bad'}`}>{c < 0 ? '−' : '+'}{compact(Math.abs(c))} cold hrs</span>}
      {risk > 0 && !m.grid_collapse_risk && <span className="m2-chip warn">{risk}% building goes dark</span>}
    </span>
  );
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
        {/* one body: the engine's facts, replaced by Granite's number-checked rewrite of them once it arrives */}
        {ev.ai_text ? (
          <p id="ev-text" className="dc-ai" key="ai"><Bot size={15} strokeWidth={2.4} aria-hidden="true" /><span>{ev.ai_text}<small>Granite on LinuxONE</small></span></p>
        ) : ev.text && <p id="ev-text" key="text">{ev.text}</p>}
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
                {o.m2 && <M2Chips m={o.m2} />}
              </span>
              {o.ai_pick && <span className="ai-badge"><Bot size={13} strokeWidth={2.6} /> AI PICK</span>}
            </button>
          ))}
        </div>
        <div className="dc-hint"><kbd>↑</kbd><kbd>↓</kbd> choose <span className="sep" /> <kbd>Enter</kbd> confirm</div>
      </div>
    </div>
  );
}
