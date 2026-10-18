import { Bell, Droplets, Flame, Plug, Snowflake, Sparkles, TrendingUp, Wrench, X, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import type { NoticeKind } from '../contracts';
import { mapControls } from '../map/controls';
import { useStore } from '../store';
import { gameClock } from '../format';
import { clock12 } from './hud';

const at = (iso: string) => { const c = clock12(gameClock(iso).time); return `${c.hm} ${c.ampm}`; };

const ICONS: Record<NoticeKind, LucideIcon> = {
  cold: Snowflake, order: TrendingUp, ice: Snowflake, repair: Wrench, restore: Plug, water: Droplets, gas: Flame, info: Sparkles,
};
const TITLES: Record<NoticeKind, string> = {
  cold: 'Homes getting cold', order: 'New cut order', ice: 'Ice on the lines', repair: 'Line repaired',
  restore: 'Power back on', water: 'Water', gas: 'Gas supply', info: 'AI co-pilot',
};
const LIFE_MS = 9000;
const MAX_SHOWN = 3;

export function Notifications() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const eventOpen = useStore((s) => !!s.state?.event);

  useEffect(() => {
    if (!toasts.length) return;
    const oldest = Math.min(...toasts.map((t) => t.born));
    const id = setTimeout(() => {
      const now = performance.now();
      for (const t of useStore.getState().toasts) if (now - t.born >= LIFE_MS) dismiss(t.id);
    }, Math.max(50, oldest + LIFE_MS - performance.now()));
    return () => clearTimeout(id);
  }, [toasts, dismiss]);

  if (eventOpen || !toasts.length) return null;
  return (
    <div className="notifications" aria-live="polite">
      {toasts.slice(-MAX_SHOWN).map((t) => {
        const Icon = ICONS[t.kind] ?? Bell;
        return (
          <div key={t.id} className={`panel toast ${t.kind} pop`}>
            <span className="toast-icon" aria-hidden="true"><Icon size={17} strokeWidth={2.4} /></span>
            <button
              type="button"
              className="toast-body"
              title={t.target ? 'Show on the map' : undefined}
              onClick={() => { if (t.target) { mapControls.focus(t.target); useStore.getState().setUI({ selected: t.target.startsWith('C-') ? t.target : null }); } dismiss(t.id); }}
            >
              <span className="toast-title">{TITLES[t.kind]}{t.time && <span className="toast-time">{at(t.time)}</span>}</span>
              <span className="toast-text">{t.text}</span>
            </button>
            <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={15} strokeWidth={2.6} /></button>
          </div>
        );
      })}
    </div>
  );
}
