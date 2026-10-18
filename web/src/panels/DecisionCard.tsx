import { AlertTriangle, Sparkles } from 'lucide-react';
import { useStore } from '../store';

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
              <span className="opt-label">{o.label}</span>
              {o.ai_pick && <span className="ai-badge"><Sparkles size={12} strokeWidth={2.6} /> AI PICK</span>}
            </button>
          ))}
        </div>
        <div className="dc-hint"><kbd>↑</kbd><kbd>↓</kbd> choose <span className="sep" /> <kbd>Enter</kbd> confirm</div>
      </div>
    </div>
  );
}
