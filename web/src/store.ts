import { create } from 'zustand';
import type { Action, BuyItem, EmergencyItem, GameState, Notice } from './contracts';
import type { GameLink } from './link/GameLink';
import type { Pick } from './map/types';
import type { Rot } from './map/iso';
import { BUILDING_BY_ID, CIRCUIT_BY_ID } from './map/layout';

export type Tool = 'inspect' | 'cut' | 'restore' | 'emergency' | 'buy';

export const CUT_MINUTES: (number | null)[] = [30, 60, 120, 240, null];

export interface UIState {
  tool: Tool;
  cutMinutes: number | null;
  emergencyItem: EmergencyItem | null;
  buyItem: BuyItem | null;
  hover: Pick | null;
  selected: string | null;
  rot: Rot;
  hidePanels: boolean;
  highlight: number; // decision card option
}

export interface Toast extends Notice { born: number }

interface Store {
  state: GameState | null;
  connected: boolean;
  linkKind: 'mock' | 'ws' | null;
  ui: UIState;
  toasts: Toast[];
  seen: Set<string>;
  link: GameLink | null;
  flash: (id: string) => void;
  setFlash: (fn: (id: string) => void) => void;
  attach: (link: GameLink) => () => void;
  send: (a: Action) => void;
  setUI: (p: Partial<UIState>) => void;
  mapClick: (p: Pick | null) => void;
  dismissToast: (id: string) => void;
}

const circuitOf = (p: Pick) => (p.kind === 'circuit' ? p.id : p.circuit);

export const useStore = create<Store>((set, get) => ({
  state: null,
  connected: false,
  linkKind: null,
  ui: {
    tool: 'inspect', cutMinutes: 120, emergencyItem: null, buyItem: null, hover: null,
    // ?sel=C-13 and ?rot=1 open the game in that view (screenshots, video takes)
    selected: new URLSearchParams(location.search).get('sel'),
    rot: ((Number(new URLSearchParams(location.search).get('rot')) || 0) % 4) as Rot,
    hidePanels: false, highlight: 0,
  },
  toasts: [],
  seen: new Set(),
  link: null,
  flash: () => {},
  setFlash: (fn) => set({ flash: fn }),

  attach(link) {
    set({ link, linkKind: link.kind });
    link.start(
      (s) => {
        const prev = get().state;
        const { seen } = get();
        const fresh = (s.notices ?? []).filter((n) => !seen.has(n.id));
        fresh.forEach((n) => seen.add(n.id));
        const now = performance.now();
        const ui = get().ui;
        // new decision card: start the highlight on the AI pick
        const highlight = s.event && s.event.id !== prev?.event?.id ? Math.max(0, s.event.options.findIndex((o) => o.ai_pick)) : ui.highlight;
        set({
          state: s,
          toasts: [...get().toasts, ...fresh.map((n) => ({ ...n, born: now }))].slice(-4),
          ui: highlight !== ui.highlight ? { ...ui, highlight } : ui,
        });
      },
      (connected) => set({ connected }),
    );
    return () => link.stop();
  },

  send(a) { get().link?.send(a); },

  setUI(p) { set({ ui: { ...get().ui, ...p } }); },

  dismissToast(id) { set({ toasts: get().toasts.filter((t) => t.id !== id) }); },

  mapClick(p) {
    const { state: st, ui, send, setUI, flash } = get();
    if (!st) return;
    if (!p) { if (ui.tool === 'inspect') setUI({ selected: null }); return; }
    const cid = circuitOf(p);
    const circuit = st.circuits.find((c) => c.id === cid);

    if (st.phase === 'ready' && ui.tool === 'buy' && ui.buyItem) {
      const item = ui.buyItem;
      const buildingTarget = p.kind === 'building' ? p.id : CIRCUIT_BY_ID[cid]?.building;
      let target: string | undefined;
      if (item === 'protect' || item === 'smart_switch') target = cid;
      else if (item === 'generator') target = buildingTarget;
      else if (item === 'warming_center') target = 'school-1';
      if (!target) { flash(cid); return; }
      const has =
        item === 'protect' ? !!circuit?.protected :
        item === 'smart_switch' ? !!circuit?.split :
        item === 'generator' ? !!st.buildings.find((b) => b.id === target)?.generator : false;
      send({ type: has ? 'sell' : 'buy', item, target });
      return;
    }

    switch (ui.tool) {
      case 'inspect':
        setUI({ selected: cid });
        break;
      case 'cut':
        if (!circuit) break;
        if (circuit.protected) { flash(cid); setUI({ selected: cid }); break; }
        send({ type: 'cut', circuit: cid, ...(ui.cutMinutes ? { minutes: ui.cutMinutes } : {}) });
        setUI({ selected: cid });
        break;
      case 'restore':
        if (circuit && !circuit.on) send({ type: 'restore', circuit: cid });
        setUI({ selected: cid });
        break;
      case 'emergency': {
        if (ui.emergencyItem === 'generator') {
          const target = p.kind === 'building' ? p.id : CIRCUIT_BY_ID[cid]?.building;
          if (!target || !BUILDING_BY_ID[target]) { flash(cid); break; }
          send({ type: 'emergency', item: 'generator', target });
        } else if (ui.emergencyItem === 'warming_center') {
          send({ type: 'emergency', item: 'warming_center', target: 'school-1' });
        }
        setUI({ tool: 'inspect', emergencyItem: null });
        break;
      }
    }
  },
}));
