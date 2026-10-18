import { Snowflake } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { startSound } from './audio/sound';
import { startVoice } from './audio/voice';
import { gameClock } from './format';
import { wantMock, wsUrl } from './link/GameLink';
import { mockLink } from './link/mockLink';
import { wsLink } from './link/wsLink';
import { CountyCanvas } from './map/CountyCanvas';
import { ReadyScreen } from './screens/ReadyScreen';
import { ReportScreen } from './screens/ReportScreen';
import { StormScreen } from './screens/StormScreen';
import { useStore } from './store';

export function App() {
  useEffect(() => {
    const link = wantMock() ? mockLink() : wsLink(wsUrl());
    return useStore.getState().attach(link);
  }, []);
  useEffect(() => startSound(useStore), []);
  useEffect(() => startVoice(useStore), []);

  const phase = useStore((s) => s.state?.phase ?? 'storm');
  const hasState = useStore((s) => !!s.state);
  const connected = useStore((s) => s.connected);

  // Start the storm: a title card while the county turns from clear day to snowy night
  const prevPhase = useRef(phase);
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (prevPhase.current === 'ready' && phase === 'storm') {
      const s = useStore.getState().state;
      const c = s ? gameClock(s.time) : null;
      const h = c ? Math.floor(c.hour) : 18;
      const when = c ? `${c.label.split(' ')[0] === 'Sun' ? 'Sunday' : c.label} ${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` : '';
      setTitle(`${when} · ${s?.outside_f ?? ''}°F`);
      const id = setTimeout(() => setTitle(null), 2600);
      prevPhase.current = phase;
      return () => clearTimeout(id);
    }
    prevPhase.current = phase;
  }, [phase]);

  return (
    <div className={`app phase-${phase}`}>
      <CountyCanvas />
      {hasState && phase === 'ready' && <ReadyScreen />}
      {hasState && phase === 'storm' && !title && <StormScreen />}
      {title && (
        <div className="storm-title" role="status">
          <span className="st-badge" aria-hidden="true"><Snowflake size={34} strokeWidth={2.2} /></span>
          <span className="st-eyebrow">The storm arrives</span>
          <h1>Winter Storm Uri</h1>
          <p className="st-when">{title}</p>
        </div>
      )}
      {hasState && phase === 'over' && <ReportScreen />}
      {!hasState && (
        <div className="connecting panel" role="status">
          <span className="spinner" aria-hidden="true" />
          {connected ? 'Waiting for the first game state…' : 'Connecting to the game server on LinuxONE…'}
        </div>
      )}
    </div>
  );
}
