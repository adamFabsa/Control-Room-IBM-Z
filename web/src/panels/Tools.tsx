import { Check, Heater, Megaphone, MousePointer2, PlugZap, Power, Scissors, Star, type LucideIcon } from 'lucide-react';
import { CUT_MINUTES, useStore, type Tool } from '../store';
import { minutesChip, minutesWords } from './hud';

type DockTool = 'inspect' | 'cut' | 'restore';

const TOOLS: { id: DockTool; label: string; key: string; Icon: LucideIcon }[] = [
  { id: 'inspect', label: 'Inspect', key: 'Esc', Icon: MousePointer2 },
  { id: 'cut', label: 'Cut power', key: 'C', Icon: Scissors },
  { id: 'restore', label: 'Restore', key: 'R', Icon: Power },
];

function hintFor(tool: Tool, generator: boolean, minutes: number | null): { text: string; Icon: LucideIcon; tone: string } | null {
  if (tool === 'cut') return { text: `Click a neighborhood to cut it ${minutesWords(minutes)}`, Icon: Scissors, tone: 'cut' };
  if (tool === 'restore') return { text: 'Click a dark neighborhood to restore it', Icon: Power, tone: 'restore' };
  if (tool === 'emergency' && generator) return { text: 'Click a building to send the generator', Icon: PlugZap, tone: 'emergency' };
  return null;
}

/** Bottom-center hotbar: the three map tools, then the emergency items you can spend points on. */
export function ToolDock() {
  const tool = useStore((s) => s.ui.tool);
  const minutes = useStore((s) => s.ui.cutMinutes);
  const item = useStore((s) => s.ui.emergencyItem);
  const points = useStore((s) => s.state?.points ?? 0);
  const warmingOpen = useStore((s) => !!s.state?.prep?.warming_center);
  const conservationOn = useStore((s) => !!s.state?.effects?.conservation);
  const setUI = useStore((s) => s.setUI);
  const send = useStore((s) => s.send);

  const genArmed = tool === 'emergency' && item === 'generator';
  const hint = hintFor(tool, genArmed, minutes);
  const pick = (t: DockTool) => setUI({ tool: t === 'inspect' || tool === t ? 'inspect' : t, emergencyItem: null });

  return (
    <>
      {tool === 'cut' && (
        <div className="panel cut-for pop" role="group" aria-label="Cut for how long">
          <span className="cut-for-label">Cut for</span>
          <div className="seg">
            {CUT_MINUTES.map((m) => (
              <button
                key={String(m)}
                type="button"
                className={m === minutes ? 'on' : ''}
                aria-pressed={m === minutes}
                aria-label={m == null ? 'Until restored' : `${m} minutes`}
                onClick={() => setUI({ cutMinutes: m })}
              >
                {minutesChip(m)}
              </button>
            ))}
          </div>
          <span className="cut-for-keys" aria-hidden="true"><kbd>[</kbd><kbd>]</kbd></span>
        </div>
      )}

      {hint && (
        <div className={`dock-hint ${hint.tone}`} role="status" key={hint.tone}>
          <span className="hint-ico"><hint.Icon size={13} strokeWidth={2.6} /></span>
          {hint.text}
        </div>
      )}

      <div className="panel dock" role="toolbar" aria-label="Tools">
        {TOOLS.map(({ id, label, key, Icon }) => {
          const on = tool === id || (id === 'inspect' && tool === 'buy');
          return (
            <button
              key={id}
              type="button"
              className={`gbtn dock-btn ${id}${on ? ' active' : ''}`}
              aria-pressed={on}
              aria-label={`${label} (${key})`}
              title={`${label} · ${key}`}
              onClick={() => pick(id)}
            >
              <span className="dock-ico"><Icon size={22} strokeWidth={2.3} /></span>
              <span className="dock-label">{label}</span>
              <kbd className="dock-key">{key}</kbd>
            </button>
          );
        })}

        <span className="dock-sep" aria-hidden="true" />

        <button
          type="button"
          className={`gbtn dock-btn emergency${genArmed ? ' active' : ''}`}
          aria-pressed={genArmed}
          aria-label="Generator, 2 points (G)"
          title={points < 2 ? 'Generator · needs 2 points' : 'Generator · 2 pts · G, then click a building'}
          disabled={points < 2 && !genArmed}
          onClick={() => setUI(genArmed ? { tool: 'inspect', emergencyItem: null } : { tool: 'emergency', emergencyItem: 'generator' })}
        >
          <span className="dock-ico"><PlugZap size={22} strokeWidth={2.3} /></span>
          <span className="dock-label">Generator</span>
          <span className="dock-cost"><Star size={9} strokeWidth={3} fill="currentColor" />2</span>
          <kbd className="dock-key">G</kbd>
        </button>
        <button
          type="button"
          className="gbtn dock-btn emergency"
          aria-label={`Open a warming center, 1 point${warmingOpen ? ' (one is open)' : ''}`}
          title={warmingOpen ? 'Warming center · open at the South Dallas school' : 'Warming center · 1 pt · opens the South Dallas school'}
          disabled={points < 1}
          onClick={() => { send({ type: 'emergency', item: 'warming_center', target: 'school-1' }); setUI({ tool: 'inspect' }); }}
        >
          <span className="dock-ico"><Heater size={22} strokeWidth={2.3} /></span>
          <span className="dock-label">Warming center</span>
          <span className="dock-cost"><Star size={9} strokeWidth={3} fill="currentColor" />1</span>
          {warmingOpen && <span className="dock-done" aria-hidden="true"><Check size={11} strokeWidth={3.4} /></span>}
        </button>
        <button
          type="button"
          className="gbtn dock-btn emergency"
          aria-label="Send a conservation alert, 1 point"
          title={conservationOn ? 'Conservation alert is running · 1 pt to extend it' : 'Conservation alert · 1 pt · asks people to use less power'}
          disabled={points < 1}
          onClick={() => { send({ type: 'emergency', item: 'conservation' }); setUI({ tool: 'inspect' }); }}
        >
          <span className="dock-ico"><Megaphone size={22} strokeWidth={2.3} /></span>
          <span className="dock-label">Conservation</span>
          <span className="dock-cost"><Star size={9} strokeWidth={3} fill="currentColor" />1</span>
          {conservationOn && <span className="dock-done" aria-hidden="true"><Check size={11} strokeWidth={3.4} /></span>}
        </button>
      </div>
    </>
  );
}
