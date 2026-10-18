import { Building2, ChevronDown, Droplets, HeartPulse, House, MapPin, Plus, Power, Scissors, Shield, Snowflake, Thermometer, Users, Wind, X, Zap, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { CIRCUIT_BY_ID, BUILDING_BY_ID, type CircuitInfo } from '../map/layout';
import { useStore } from '../store';
import { dur, fmt } from '../format';

function NeedBar({ Icon, label, value, text }: { Icon: LucideIcon; label: string; value: number; text: string }) {
  const v = Math.max(0, Math.min(1, value));
  const tone = v > 0.6 ? 'good' : v > 0.3 ? 'mid' : 'bad';
  return (
    <div className={`need ${tone}`}>
      <span className="need-ico" aria-hidden="true"><Icon size={16} strokeWidth={2.4} /></span>
      <div className="need-main">
        <div className="need-row"><span className="need-label">{label}</span><span className="need-text">{text}</span></div>
        <div className="need-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-valuetext={text}>
          <i style={{ width: `${v * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

type Moodlet = { text: string; Icon: LucideIcon; tone: 'warn' | 'cold' | 'info' | 'good' };

const SVI_NOTE = "CDC/ATSDR Social Vulnerability Index 2022, averaged over this circuit's census tracts";
const sviLevel = (v: number) => (v >= 0.7 ? 'high' : v >= 0.45 ? 'medium' : 'low');

/** The real Dallas behind the game circuit: one line (CDC vulnerability), opening to the census and the suburbs. */
function RealPlace({ info, open, onToggle }: { info: CircuitInfo; open: boolean; onToggle: () => void }) {
  const level = info.svi != null ? sviLevel(info.svi) : null;
  const moreId = `real-${info.id}`;
  return (
    <div className={`hc-real${open ? ' open' : ''}`}>
      <button type="button" className="hc-real-row" aria-expanded={open} aria-controls={moreId} title={info.svi != null ? SVI_NOTE : undefined} onClick={onToggle}>
        <span className="hc-real-tag">Real place</span>
        {info.svi != null && level ? (
          <span className="hc-svi">CDC vulnerability <b className="mono">{info.svi.toFixed(2)}</b> <em className={level}>{level}</em></span>
        ) : (
          <span className="hc-svi">Census tracts</span>
        )}
        <ChevronDown className="hc-real-chev" size={15} strokeWidth={2.6} aria-hidden="true" />
      </button>
      {open && (
        <div className="hc-real-more" id={moreId}>
          <span><Users size={13} strokeWidth={2.5} aria-hidden="true" />Census: <b className="mono">{fmt(Math.round(info.realPop / 1000) * 1000)}</b> people in its tracts</span>
          {info.covers.length > 0 && <span><MapPin size={13} strokeWidth={2.5} aria-hidden="true" />Also covers: {info.covers.join(', ')}</span>}
        </div>
      )}
    </div>
  );
}

export function NeighborhoodCard() {
  const id = useStore((s) => s.ui.selected);
  const c = useStore((s) => s.state?.circuits.find((x) => x.id === s.ui.selected));
  const outside = useStore((s) => s.state?.outside_f ?? 20);
  const boil = useStore((s) => s.state?.effects?.boil_water_people ?? 0);
  const send = useStore((s) => s.send);
  const setUI = useStore((s) => s.setUI);
  const minutes = useStore((s) => s.ui.cutMinutes);
  const [about, setAbout] = useState(false); // stays open from one neighborhood to the next
  if (!id || !c) return null;
  const info = CIRCUIT_BY_ID[id];
  const bld = info?.building ? BUILDING_BY_ID[info.building]?.name : info?.towers ? 'Office towers' : null;
  // 68°F fills the bar; the 50°F cold line sits at 30%; the outside temperature is empty
  const out = Math.min(outside, 49);
  const warmth = c.indoor_f >= 50 ? 0.3 + (0.7 * (c.indoor_f - 50)) / 18 : (0.3 * (c.indoor_f - out)) / (50 - out);
  const timer = !c.on && c.restore_in_min != null && c.restore_in_min > 0;
  const cold = !c.on && c.indoor_f < 50;
  const look = cold ? 'cold' : !c.on ? 'dark' : c.protected ? 'protected' : 'powered';
  const lookText = { cold: 'Cold homes', dark: 'Dark, still warm', protected: 'Protected', powered: 'Powered' }[look];

  const moodlets: Moodlet[] = [];
  if (bld) moodlets.push({ text: `On this line: ${bld}`, Icon: Building2, tone: 'info' });
  if ((info?.v ?? 0) >= 0.7) moodlets.push({ text: 'Older homes · cool fast', Icon: Wind, tone: 'warn' });
  if (boil > 0) moodlets.push({ text: 'Boil-water notice', Icon: Droplets, tone: 'warn' });
  if (c.protected) moodlets.push({ text: 'Protected', Icon: Shield, tone: 'good' });
  if (c.broken) moodlets.push({ text: 'Ice broke the line', Icon: Snowflake, tone: 'cold' });
  if (c.medical) moodlets.push({ text: `Medical devices: ${fmt(c.medical)}`, Icon: HeartPulse, tone: 'cold' });

  return (
    <section className={`panel hood-card pop ${look}`} aria-labelledby="hood-title" key={id}>
      <button type="button" className="close" aria-label="Close" title="Close · Esc" onClick={() => setUI({ selected: null })}><X size={16} strokeWidth={2.6} /></button>
      <header className="hc-head">
        <span className={`hc-badge ${look}`} role="img" aria-label={lookText} title={lookText}>
          <House size={22} strokeWidth={2.4} />
        </span>
        <div className="hc-title">
          <h2 id="hood-title">{c.area}</h2>
          <span className="hc-sub"><span className="mono">{id}</span> · {fmt(c.people)} people · {c.mw} MW</span>
        </div>
      </header>

      <p className="hc-status">
        {c.on
          ? <>Powered. Homes are at <b>{Math.round(c.indoor_f)}°F</b> inside.</>
          : <>Dark for <b>{dur(c.dark_min)}</b>. Homes are down to <b className={cold ? 'cold' : 'dark'}>{Math.round(c.indoor_f)}°F</b> inside.</>}
      </p>

      <div className="needs">
        <NeedBar Icon={Thermometer} label="Warmth" value={warmth} text={`${Math.round(c.indoor_f)}°F`} />
        <NeedBar Icon={Droplets} label="Water" value={boil > 0 ? 0.15 : 1} text={boil > 0 ? 'Boil notice' : 'Running'} />
        <NeedBar
          Icon={Zap}
          label="Power"
          value={c.on ? 1 : timer ? 0.4 : 0.05}
          text={c.on ? 'On' : timer ? `Back in ${dur(c.restore_in_min!)}` : 'Off until restored'}
        />
      </div>

      {moodlets.length > 0 && (
        <div className="moodlets">
          {moodlets.map(({ text, Icon, tone }) => (
            <span key={text} className={`moodlet ${tone}`}>
              <span className="m-ico" aria-hidden="true"><Icon size={11} strokeWidth={2.8} /></span>
              {text}
            </span>
          ))}
        </div>
      )}

      {info && <RealPlace info={info} open={about} onToggle={() => setAbout(!about)} />}

      <div className="hc-actions">
        {c.protected ? (
          <button type="button" className="gbtn wide" disabled><Shield size={18} strokeWidth={2.4} /> Protected · can't be cut</button>
        ) : c.on ? (
          <button type="button" className="gbtn amber wide" onClick={() => send({ type: 'cut', circuit: c.id, ...(minutes ? { minutes } : {}) })}>
            <Scissors size={18} strokeWidth={2.4} />
            Cut {minutes ? `for ${minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}` : 'until restored'}
          </button>
        ) : (
          <>
            <button type="button" className="gbtn ice wide" onClick={() => send({ type: 'restore', circuit: c.id })}>
              <Power size={18} strokeWidth={2.6} /> Turn power back on
            </button>
            <button
              type="button"
              className="gbtn ghost plus-hour"
              aria-label="Keep it off one more hour"
              title="Keep it off one more hour"
              onClick={() => send({ type: 'cut', circuit: c.id, minutes: (c.restore_in_min ?? 0) + 60 })}
            >
              <Plus size={15} strokeWidth={3} />1 h
            </button>
          </>
        )}
      </div>
    </section>
  );
}
