// The sound system. One AudioContext, made on the first click or key press (autoplay rules), feeding a master
// bus with a soft compressor. A wind bed follows the phase and the snow; soft event sounds come from diffing
// each new game state against the last one. M toggles mute, and the choice is remembered.
import type { Circuit, GameState, NoticeKind } from '../contracts';
import { createMasterBus, glide, Synth, Wind, type MasterBus, type PingKind, type WindMood } from './synth';

/** The slice of the zustand store the sound system reads. `useStore` fits it as is. */
export interface SoundSnapshot {
  state: GameState | null;
  ui: { tool: string };
}

export interface SoundStore {
  getState(): SoundSnapshot;
  subscribe(listener: (s: SoundSnapshot, prev: SoundSnapshot) => void): () => void;
}

/** Master volume after the compressor. Event sounds peak around -13 dBFS, the storm wind sits near -30 dBFS RMS. */
const VOLUME = 0.7;
const STORAGE_KEY = 'control-room-uri:muted';
const GESTURES = ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const;

// ------------------------------------------------------------------ mute (works with or without a running engine)

function readMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(m: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, m ? '1' : '0');
  } catch {
    /* storage blocked: the choice still holds for this visit */
  }
}

let muted = readMuted();
const muteListeners = new Set<() => void>();
let active: SoundSystem | null = null;

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  if (m === muted) return;
  muted = m;
  writeMuted(m);
  active?.onMuteChange();
  muteListeners.forEach((fn) => fn());
}

export function toggleMuted(): void {
  setMuted(!muted);
}

export function subscribeMuted(fn: () => void): () => void {
  muteListeners.add(fn);
  return () => {
    muteListeners.delete(fn);
  };
}

/** Start listening to the store and for the first gesture. Returns a stop function (use it as effect cleanup). */
export function startSound(store: SoundStore): () => void {
  active?.stop();
  const sys = new SoundSystem(store);
  active = sys;
  return () => {
    sys.stop();
    if (active === sys) active = null;
  };
}

// ------------------------------------------------------------------ engine

type Phase = 'ready' | 'storm' | 'over';

interface Engine {
  ctx: AudioContext;
  bus: MasterBus;
  synth: Synth;
  wind: Wind;
}

// which notice to ping for when several arrive together
const NOTICE_RANK: Record<NoticeKind, number> = { cold: 3, ice: 3, restore: 2, repair: 2, order: 1, water: 1, gas: 1, info: 0 };
const rank = (k: NoticeKind): number => NOTICE_RANK[k] ?? 0;
/** Everything placed so far: protections, smart switches, generators, warming centers and the county-wide items. */
function placedCount(s: GameState): number {
  const p = s.prep ?? {};
  return s.circuits.filter((c) => c.protected || c.parent).length + s.buildings.filter((b) => b.generator).length
    + (s.warming_centers?.length ?? 0) + (p.keep_gas ? 1 : 0) + (p.conservation ? 1 : 0) + (p.repair_crews ? 1 : 0);
}

const pingKind = (k: NoticeKind): PingKind => (k === 'cold' || k === 'ice' ? 'cold' : k === 'restore' || k === 'repair' ? 'bright' : 'neutral');

function moodFor(phase: Phase | null, snow: number): WindMood {
  if (phase === 'storm') return { level: 0.65 + 0.35 * snow, center: 480 + 160 * snow, depth: 140 + 120 * snow, rumble: 0.7 + 0.5 * snow };
  if (phase === 'ready') return { level: 0.55, center: 420, depth: 90, rumble: 0.3 }; // a clear day: barely a breeze
  return { level: 0, center: 420, depth: 90, rumble: 0.3 };
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

class SoundSystem {
  private readonly store: SoundStore;
  private readonly unsub: () => void;
  private eng: Engine | null = null;
  private failed = false;
  private stopped = false;
  /** the master is up: unmuted and the tab is visible */
  private live = false;
  private gestureAt = -Infinity;
  private suspendTimer = 0;
  private gustTimer = 0;
  private pingTimer = 0;
  private pendingPing: NoticeKind | null = null;
  private readonly seen = new Set<string>();
  private amb: { phase: Phase | null; snow: number; at: number } = { phase: null, snow: -1, at: -Infinity };
  private readonly last = { tick: -1e9, select: -1e9, cut: -1e9, restore: -1e9, bell: -1e9, ping: -1e9, order: -1e9, place: -1e9, repair: -1e9 };
  /** the cut order the last alert sounded for; a new alert needs a real jump above it */
  private alertedOrder = 0;

  constructor(store: SoundStore) {
    this.store = store;
    const st = store.getState().state;
    if (st) this.markSeen(st); // what is already on screen never pings
    this.unsub = store.subscribe(this.onChange);
    for (const type of GESTURES) window.addEventListener(type, this.onGesture, true);
    document.addEventListener('pointerdown', this.onPointer, true);
    window.addEventListener('keydown', this.onKey);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsub();
    for (const type of GESTURES) window.removeEventListener(type, this.onGesture, true);
    document.removeEventListener('pointerdown', this.onPointer, true);
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.clearTimeout(this.suspendTimer);
    window.clearTimeout(this.gustTimer);
    window.clearTimeout(this.pingTimer);
    const e = this.eng;
    this.eng = null;
    this.live = false;
    if (!e) return;
    // a quick fade so stopping never clicks, then tear the graph down
    glide(e.bus.volume.gain, 0, e.ctx.currentTime, 0.02);
    window.setTimeout(() => {
      e.wind.dispose();
      e.bus.dispose();
      e.ctx.close().catch(() => {});
    }, 150);
  }

  onMuteChange(): void {
    this.syncRun();
    if (muted) return;
    const s = this.canPlay();
    if (s) s.select('restore', 0.12); // a soft "sound is on"
  }

  // ---------------------------------------------------------------- context lifecycle

  private onGesture = (): void => {
    this.gestureAt = performance.now();
    if (!this.eng && !this.failed) this.boot();
    this.syncRun();
  };

  private onVisibility = (): void => this.syncRun();

  private boot(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.failed = true;
      return;
    }
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const bus = createMasterBus(ctx, ctx.destination, 0); // starts silent; syncRun fades it up
      const synth = new Synth(ctx, bus.input);
      const wind = new Wind(ctx, synth.noiseBuf, bus.input);
      this.eng = { ctx, bus, synth, wind };
    } catch {
      this.failed = true;
      return;
    }
    this.ambience(this.store.getState().state, true);
    this.queueGust();
  }

  /** Run the context (and fade the master up) only while unmuted and visible; otherwise fade out and suspend. */
  private syncRun(): void {
    const e = this.eng;
    if (!e || e.ctx.state === 'closed') return;
    if (!muted && !document.hidden) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = 0;
      if (e.ctx.state !== 'running') e.ctx.resume().catch(() => {});
      if (!this.live) {
        this.live = true;
        glide(e.bus.volume.gain, VOLUME, e.ctx.currentTime, 0.08);
      }
      return;
    }
    if (this.live) {
      this.live = false;
      glide(e.bus.volume.gain, 0, e.ctx.currentTime, 0.03);
    }
    if (!this.suspendTimer && e.ctx.state === 'running') {
      this.suspendTimer = window.setTimeout(() => {
        this.suspendTimer = 0;
        const c = this.eng?.ctx;
        if (c && !this.live && c.state === 'running') c.suspend().catch(() => {});
      }, 250);
    }
  }

  /** The synth, if a sound may play right now. A context still starting from a fresh gesture counts. */
  private canPlay(): Synth | null {
    const e = this.eng;
    if (!e || !this.live || muted || document.hidden) return null;
    const st = e.ctx.state;
    if (st === 'running' || (st === 'suspended' && performance.now() - this.gestureAt < 800)) return e.synth;
    return null;
  }

  // ---------------------------------------------------------------- input

  /** One delegated listener: a soft tick for any enabled button in the HUD. */
  private onPointer = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const btn = e.target instanceof Element ? e.target.closest('.hud button') : null;
    if (!btn || (btn instanceof HTMLButtonElement && btn.disabled) || btn.getAttribute('aria-disabled') === 'true') return;
    const now = performance.now();
    if (now - this.last.tick < 40) return;
    const s = this.canPlay();
    if (!s) return;
    this.last.tick = now;
    s.tick(s.at());
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return;
    if (e.key !== 'm' && e.key !== 'M') return;
    if (isTyping(e.target) || isTyping(document.activeElement)) return;
    toggleMuted();
  };

  // ---------------------------------------------------------------- game state

  private onChange = (s: SoundSnapshot, p: SoundSnapshot): void => {
    if (s.state !== p.state && s.state) this.onState(s.state, p.state);
    if (s.ui.tool !== p.ui.tool) this.onTool(s.ui.tool);
  };

  private onTool(tool: string): void {
    const now = performance.now();
    if (now - this.last.select < 60) return;
    const s = this.canPlay();
    if (!s) return;
    this.last.select = now;
    s.select(tool);
  }

  /** Runs for every state (up to 24 a second at top speed): reference checks first, small loops only. */
  private onState(cur: GameState, prev: GameState | null): void {
    this.ambience(cur, false);
    const fresh = cur.notices !== prev?.notices ? this.markSeen(cur) : null;
    if (!prev) return;
    const s = this.canPlay();
    if (!s) return;
    const now = performance.now();

    const phase = cur.phase ?? 'storm', was = prev.phase ?? 'storm';
    if (phase !== was) {
      if (phase === 'over') {
        s.resolve(s.at(0.25));
        return;
      }
      if (was === 'ready' && phase === 'storm') s.stormArrives(s.at());
    }

    let delay = 0;
    // the grid operator: an alert when cuts begin, and again when the order jumps 200 MW past the last alert
    const order = cur.order_mw ?? 0;
    if (order <= 0) this.alertedOrder = 0;
    else if (now - this.last.order > 2500 && (this.alertedOrder === 0 || order - this.alertedOrder >= 200)) {
      s.order(s.at(), this.alertedOrder === 0);
      this.last.order = now;
      this.alertedOrder = order;
      delay = 0.5;
    }
    // something placed (Get ready purchases, emergency buys): a thunk and a sparkle
    if (placedCount(cur) > placedCount(prev) && now - this.last.place > 150) {
      this.last.place = now;
      s.place(s.at(delay));
      delay = Math.max(delay, 0.3);
    }
    // an iced line repaired: a wrench and a chime
    const fixedLines = prev.circuits.filter((c) => c.broken && !cur.circuits.find((x) => x.id === c.id)?.broken).length;
    if (fixedLines && now - this.last.repair > 500) {
      this.last.repair = now;
      s.repair(s.at(delay));
      delay = Math.max(delay, 0.5);
    }
    const { cuts, restores } = diffCircuits(cur.circuits, prev.circuits);
    if (cuts && now - this.last.cut > 200) {
      this.last.cut = now;
      s.cut(s.at(delay), cuts);
      delay = 0.25;
    }
    let restored = false;
    if (restores && now - this.last.restore > 250) {
      this.last.restore = now;
      s.restore(s.at(cuts ? 0.12 : 0));
      restored = true;
      delay = Math.max(delay, 0.3);
    }

    const ev = cur.event;
    if (ev && ev.id !== prev.event?.id && now - this.last.bell > 600) {
      this.last.bell = now;
      s.bell(s.at(delay * 0.5));
      delay = Math.max(delay, 0.45);
    }

    // a timed restore already rang its chime; its "back on" notice needs no second sound
    if (fresh && !(restored && pingKind(fresh) === 'bright')) this.ping(fresh, delay);
  }

  /** Remember every notice id; return the most important kind among the new ones. */
  private markSeen(st: GameState): NoticeKind | null {
    const ns = st.notices;
    if (!ns || !ns.length) return null;
    let best: NoticeKind | null = null;
    for (const n of ns) {
      if (this.seen.has(n.id)) continue;
      this.seen.add(n.id);
      if (best === null || rank(n.kind) > rank(best)) best = n.kind;
    }
    if (this.seen.size > 500) {
      this.seen.clear();
      for (const n of ns) this.seen.add(n.id);
    }
    return best;
  }

  /** At most one ping per 400 ms. One that comes too soon waits for the window (only the most important is kept). */
  private ping(kind: NoticeKind, delay: number): void {
    const now = performance.now();
    const at = now + delay * 1000;
    if (at - this.last.ping >= 400) {
      const s = this.canPlay();
      if (!s) return;
      this.last.ping = at;
      s.ping(s.at(delay), pingKind(kind));
      return;
    }
    if (this.pendingPing === null || rank(kind) >= rank(this.pendingPing)) this.pendingPing = kind;
    if (!this.pingTimer) {
      this.pingTimer = window.setTimeout(() => {
        this.pingTimer = 0;
        const k = this.pendingPing;
        this.pendingPing = null;
        if (k && !this.stopped) this.ping(k, 0);
      }, Math.ceil(this.last.ping + 400 - now) + 5);
    }
  }

  // ---------------------------------------------------------------- ambience

  /** Ease the wind toward the phase and snow. Snow-only changes are applied at most twice a second. */
  private ambience(st: GameState | null, force: boolean): void {
    const e = this.eng;
    if (!e) return;
    const phase: Phase | null = st ? (st.phase ?? 'storm') : null;
    const raw = st?.weather?.snow;
    const snow = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.6;
    const now = performance.now();
    const changed = phase !== this.amb.phase;
    if (!force && !changed && (Math.abs(snow - this.amb.snow) < 0.02 || now - this.amb.at < 500)) return;
    this.amb = { phase, snow, at: now };
    e.wind.set(moodFor(phase, snow), force ? 1.2 : changed ? (phase === 'over' ? 1.5 : 1.1) : 2);
  }

  /** Every 4.5–12 s, a gust on top of the wind's own slow swing: strong in the storm, faint on the clear day. */
  private queueGust(): void {
    window.clearTimeout(this.gustTimer);
    this.gustTimer = window.setTimeout(() => {
      const e = this.eng;
      if (!e || this.stopped) return;
      if (this.live && e.ctx.state === 'running') {
        if (this.amb.phase === 'storm') e.wind.gust(0.35 + 0.65 * this.amb.snow);
        else if (this.amb.phase === 'ready') e.wind.gust(0.2);
      }
      this.queueGust();
    }, 4500 + Math.random() * 7500);
  }
}

/** Count circuits that went dark and came back since the last state (15 circuits, usually in the same order). */
function diffCircuits(cur: Circuit[] | undefined, prev: Circuit[] | undefined): { cuts: number; restores: number } {
  let cuts = 0, restores = 0;
  if (!cur || !prev || cur === prev) return { cuts, restores };
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i];
    const p = prev[i]?.id === c.id ? prev[i] : prev.find((x) => x.id === c.id);
    if (!p || p.on === c.on) continue;
    if (c.on) restores++;
    else cuts++;
  }
  return { cuts, restores };
}
