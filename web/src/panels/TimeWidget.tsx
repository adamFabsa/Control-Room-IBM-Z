import { Hourglass, Moon, Pause, Play, Sun, Sunrise, Sunset, Thermometer } from 'lucide-react';
import type { CSSProperties } from 'react';
import { gameClock } from '../format';
import { SUNRISE, SUNSET, goldenAt, skyPhase } from '../sky';
import { useStore } from '../store';
import { guide, useGuideOpen } from './Guide';
import { clock12 } from './hud';
import { StormTimeline } from './StormTimeline';

const SPEEDS = [1, 2, 3, 4, 5];

const hhmm = (h: number) => { const c = clock12(`${Math.floor(h)}:${Math.round((h % 1) * 60)}`); return `${c.hm} ${c.ampm}`; };
/** The dial's face, from the same sun times the 3D county uses (sky.ts), so the dial and the map agree. */
const SKY = {
  night: { Icon: Moon, size: 22, label: `Night · sunrise ${hhmm(SUNRISE)}` },
  dawn: { Icon: Sunrise, size: 24, label: `Sunrise ${hhmm(SUNRISE)}` },
  day: { Icon: Sun, size: 24, label: `Daylight · sunset ${hhmm(SUNSET)}` },
  dusk: { Icon: Sunset, size: 24, label: `Sunset ${hhmm(SUNSET)}` },
};

export function TimeWidget({ compact = false }: { compact?: boolean }) {
  const time = useStore((s) => s.state?.time);
  const outside = useStore((s) => s.state?.outside_f);
  const paused = useStore((s) => s.state?.paused ?? true);
  const speed = useStore((s) => s.state?.speed ?? 1);
  const eventOpen = useStore((s) => !!s.state?.event);
  const linkKind = useStore((s) => s.linkKind);
  const connected = useStore((s) => s.connected);
  const send = useStore((s) => s.send);
  const guideOpen = useGuideOpen();

  const clock = time ? gameClock(time) : null;
  const hour = clock?.hour ?? 12;
  const phase = skyPhase(hour);
  const face = SKY[phase];
  const t12 = clock ? clock12(clock.time) : null;
  const status = eventOpen ? 'decide' : paused ? 'paused' : 'live';
  const link = linkKind === 'mock' ? 'MOCK' : connected ? 'LINUXONE' : 'OFFLINE';

  return (
    <section className={`panel time-widget pop${compact ? ' compact' : ''}`} aria-label="Game clock">
      <header className="tw-head">
        <span className="brand">CONTROL ROOM: <b>URI</b></span>
        <span className="tw-head-end">
          <span className={`link-badge ${connected ? 'up' : 'down'}`} title={linkKind === 'mock' ? 'Mock game in the browser' : 'Live LinuxONE server'}>
            {link}
          </span>
          {!compact && (
            <button
              type="button"
              className={`help-btn${guideOpen ? ' on' : ''}`}
              aria-label="How to play"
              aria-pressed={guideOpen}
              aria-keyshortcuts="Shift+?"
              title="How to play · ?"
              onClick={guide.toggle}
            >
              ?
            </button>
          )}
        </span>
      </header>

      <div className="tw-main">
        <div className={`sky-dial ${phase}`} style={{ '--p': hour / 24, '--g': goldenAt(hour).toFixed(3) } as CSSProperties} title={face.label} aria-hidden="true">
          <span className="sky-glow" />
          <span className="sky-ring" />
          <span className="sky-hand"><i /></span>
          <face.Icon size={face.size} strokeWidth={2.2} />
        </div>
        <div className="tw-clock">
          <span className="tw-date">{clock?.label ?? '—'}</span>
          <span className="tw-time">
            <b>{t12?.hm ?? '--:--'}</b>
            {t12 && <small>{t12.ampm}</small>}
          </span>
        </div>
        {outside != null && (
          <span className={`temp-chip ${outside < 20 ? 'cold' : 'ice'}`} title="Outside temperature">
            <Thermometer size={15} strokeWidth={2.4} />
            {outside}°F
          </span>
        )}
      </div>

      {compact ? (
        <div className="tw-stopped">
          <Hourglass size={14} strokeWidth={2.4} />
          Time is stopped until the storm
        </div>
      ) : (
        <div className="tw-controls">
          <button
            type="button"
            className={`gbtn play-btn${paused ? ' ice' : ''}`}
            aria-label={paused ? 'Play' : 'Pause'}
            disabled={eventOpen}
            title={eventOpen ? 'Decide on the card first' : `${paused ? 'Play' : 'Pause'} · Space`}
            onClick={() => send({ type: paused ? 'play' : 'pause' })}
          >
            {paused ? <Play size={20} fill="currentColor" strokeWidth={2} /> : <Pause size={20} fill="currentColor" strokeWidth={2} />}
          </button>
          <div className="speed-pill" role="group" aria-label="Game speed">
            {SPEEDS.map((v) => (
              <button
                key={v}
                type="button"
                aria-label={`Speed ${v}`}
                aria-pressed={v === speed}
                title={`Speed ${v} · key ${v}`}
                className={`${v <= speed ? 'lit' : ''}${v === speed ? ' cur' : ''}`}
                onClick={() => send({ type: 'speed', value: v })}
              >
                <i style={{ height: 6 + v * 3.5 }} />
              </button>
            ))}
          </div>
          <span className={`tw-status ${status}`} role="status">
            <span className="dot" />
            {status === 'decide' ? 'DECIDE' : status === 'paused' ? 'PAUSED' : 'LIVE'}
          </span>
        </div>
      )}
      {!compact && <StormTimeline />}
    </section>
  );
}
