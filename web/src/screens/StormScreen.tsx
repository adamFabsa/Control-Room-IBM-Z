import { useEffect, useRef } from 'react';
import { mapControls } from '../map/controls';
import type { Rot } from '../map/iso';
import { CameraWidget } from '../panels/CameraWidget';
import { DecisionCard } from '../panels/DecisionCard';
import { Guide, guide } from '../panels/Guide';
import { NeighborhoodCard } from '../panels/NeighborhoodCard';
import { Notifications } from '../panels/Notifications';
import { OrderBar } from '../panels/OrderBar';
import { StatsBar } from '../panels/StatsBar';
import { TimeWidget } from '../panels/TimeWidget';
import { ToolDock } from '../panels/Tools';
import { CUT_MINUTES, useStore } from '../store';

export function useMapKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      const st = useStore.getState();
      const s = st.state;
      const ui = st.ui;
      const k = e.key;
      const ev = s?.event;
      if (ev && (k === 'ArrowUp' || k === 'ArrowDown')) {
        e.preventDefault();
        const n = ev.options.length;
        st.setUI({ highlight: (ui.highlight + (k === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if (ev && k === 'Enter') {
        e.preventDefault();
        const o = ev.options[ui.highlight] ?? ev.options[0];
        st.send({ type: 'choose', event: ev.id, option: o.id });
        return;
      }
      switch (k.toLowerCase()) {
        case ' ':
          e.preventDefault();
          if (s && !ev && s.phase === 'storm') st.send({ type: s.paused ? 'play' : 'pause' });
          break;
        case '1': case '2': case '3': case '4': case '5':
          st.send({ type: 'speed', value: Number(k) });
          break;
        case 'c': st.setUI({ tool: ui.tool === 'cut' ? 'inspect' : 'cut', emergencyItem: null }); break;
        case 'r': st.setUI({ tool: ui.tool === 'restore' ? 'inspect' : 'restore', emergencyItem: null }); break;
        case 'g': {
          // G arms the generator (2 pts, then click a building); pressing it again puts it away
          const armed = ui.tool === 'emergency' && ui.emergencyItem === 'generator';
          if (armed || s?.phase !== 'storm' || (s?.points ?? 0) < 2) st.setUI({ tool: ui.tool === 'emergency' ? 'inspect' : ui.tool, emergencyItem: null });
          else st.setUI({ tool: 'emergency', emergencyItem: 'generator' });
          break;
        }
        case 'escape': st.setUI({ tool: 'inspect', selected: null, emergencyItem: null, buyItem: null }); break;
        case 'q': st.setUI({ rot: (((ui.rot + 3) % 4) as Rot) }); break;
        case 'e': st.setUI({ rot: (((ui.rot + 1) % 4) as Rot) }); break;
        case '+': case '=': mapControls.zoomBy(1.25); break;
        case '-': case '_': mapControls.zoomBy(0.8); break;
        case 'h': st.setUI({ hidePanels: !ui.hidePanels }); break;
        case '?': if ((s?.phase ?? 'storm') === 'storm') guide.toggle(); break;
        case '[': case ']': {
          const i = CUT_MINUTES.indexOf(ui.cutMinutes);
          const j = Math.max(0, Math.min(CUT_MINUTES.length - 1, i + (k === ']' ? 1 : -1)));
          st.setUI({ cutMinutes: CUT_MINUTES[j], tool: 'cut' });
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function StormScreen() {
  useMapKeys();
  const eventId = useStore((s) => s.state?.event?.id);
  const target = useStore((s) => s.state?.event?.target);
  const hide = useStore((s) => s.ui.hidePanels);

  // fly to whatever the decision is about, then, once it's answered, back to the view the player had before
  // (cards that come one after another keep the first view)
  const hadCard = useRef(false);
  const before = useRef<[number, number, number] | null>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (eventId) {
      if (!hadCard.current) { before.current = mapControls.view(); moved.current = false; }
      hadCard.current = true;
      if (target) { mapControls.focus(target, 3.4); moved.current = true; }
      return;
    }
    if (!hadCard.current) return;
    hadCard.current = false;
    if (!moved.current) return;
    const back = before.current;
    const id = setTimeout(() => (back ? mapControls.flyTo(back) : mapControls.refit()), 900);
    return () => clearTimeout(id);
  }, [eventId, target]);

  if (hide) return null;
  return (
    <div className="hud storm">
      <div className="slot top-left"><TimeWidget /></div>
      <div className="slot top-center"><OrderBar /></div>
      {/* one right-hand column: stats, then the decision card or the notices, and the neighborhood card at the bottom */}
      <div className="slot right">
        <StatsBar />
        {eventId ? <DecisionCard /> : <Notifications />}
        {!eventId && <NeighborhoodCard />}
      </div>
      <div className="slot bottom-left"><CameraWidget /></div>
      <div className="slot bottom-center"><ToolDock /></div>
      <Guide />
    </div>
  );
}
