// The AI voice guide: short spoken lines at the key moments of a game. The server writes each line from the live
// game and speaks it with ElevenLabs (POST /api/voice {line}); it's off when the server has no key. V turns it on
// and off (remembered), and muting the game (M) silences it too.
import type { GameState } from '../contracts';
import { isMuted, subscribeMuted } from './sound';

type Line = 'intro' | 'storm' | 'order' | 'card' | 'short' | 'cold' | 'report';
const STORAGE_KEY = 'control-room-uri:voice';

let available = false;
let on = (() => { try { return localStorage.getItem(STORAGE_KEY) !== '0'; } catch { return true; } })();
let audio: HTMLAudioElement | null = null;
let busy = false;
const queue: Line[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const voice = {
  available: () => available,
  on: () => on,
  toggle(): void {
    on = !on;
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* not remembered */ }
    if (!on) stop();
    notify();
  },
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
};

function stop(): void {
  queue.length = 0;
  audio?.pause();
  audio = null;
  busy = false;
}

/** Queue a line; the newest wins when lines pile up, so the voice never runs behind the game. */
function say(line: Line): void {
  if (!available || !on || isMuted()) return;
  if (queue.length >= 2) queue.shift();
  queue.push(line);
  if (!busy) void next();
}

async function next(): Promise<void> {
  const line = queue.shift();
  if (!line) { busy = false; return; }
  busy = true;
  try {
    const r = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line }) });
    if (r.ok && on && !isMuted()) {
      const url = URL.createObjectURL(await r.blob());
      audio = new Audio(url);
      await new Promise<void>((done) => {
        audio!.onended = audio!.onerror = () => done();
        audio!.play().catch(() => done());
      });
      URL.revokeObjectURL(url);
    }
  } catch { /* the guide just stays quiet */ }
  void next();
}

interface VoiceStore {
  getState(): { state: GameState | null };
  subscribe(listener: (s: { state: GameState | null }, prev: { state: GameState | null }) => void): () => void;
}

/** Watches the game and speaks once per moment: the intro, the storm, the first order, every card that stops the
 *  game, the first dangerous shortfall, the first cold homes, and the report. */
export function startVoice(store: VoiceStore): () => void {
  fetch('/api/voice').then((r) => r.json()).then((d) => { available = !!d.enabled; notify(); }).catch(() => {});
  let said = new Set<string>();
  let gestured = false;
  const onGesture = () => {
    if (gestured) return;
    gestured = true;
    if (store.getState().state?.phase === 'ready' && !said.has('intro')) { said.add('intro'); say('intro'); }
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof HTMLInputElement)) voice.toggle();
  };
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  window.addEventListener('keydown', onKey);
  const unMuted = subscribeMuted(() => { if (isMuted()) stop(); });
  const unStore = store.subscribe(({ state: cur }, { state: prev }) => {
    if (!cur || cur === prev) return;
    const once = (key: string, line: Line) => { if (!said.has(key)) { said.add(key); say(line); } };
    if (cur.phase === 'ready' && prev?.phase && prev.phase !== 'ready') said = new Set(); // a new game
    if (cur.phase === 'ready' && gestured) once('intro', 'intro');
    if (cur.phase === 'storm' && prev?.phase === 'ready') once('storm', 'storm');
    if (cur.phase === 'storm' && cur.order_mw > 0 && !(prev && prev.order_mw > 0)) once('order', 'order');
    if (cur.event && cur.event.id !== prev?.event?.id) once(`card-${cur.event.id}`, 'card');
    for (const n of cur.notices ?? []) {
      if (n.id.startsWith('order-short') || n.id.startsWith('order-hold')) once('short', 'short');
      if (n.kind === 'cold') once('cold', 'cold');
    }
    if (cur.phase === 'over' && prev?.phase === 'storm') setTimeout(() => once('report', 'report'), 2500);
  });
  return () => {
    unStore(); unMuted(); stop();
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
    window.removeEventListener('keydown', onKey);
  };
}
