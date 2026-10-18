// A stand-in for the engine + server so the screens can be built and demoed without LinuxONE.
// Rules follow the spec's Game numbers; the temperature and order curves are hand-made (labelled mock).
import type { Action, BuyItem, GameEvent, GameState, Notice, NoticeKind, Phase } from '../contracts';
import { BUILDINGS, CIRCUIT_BY_ID, CIRCUITS, type BuildingInfo } from '../map/layout';
import type { GameLink } from './GameLink';

/** Mock snowfall (0–1) by hours after Sun 14 Feb 18:00, shaped on Uri in Dallas: heavy snow Sunday night
 *  into Monday morning, a clear and bitter Tuesday, a second round Wednesday night into Thursday. */
function snowAt(h: number): number {
  const k: [number, number][] = [[-30, 0], [-4, 0], [-1, 0.9], [12, 1], [16, 0.35], [20, 0], [44, 0], [50, 0.35], [56, 0.9], [64, 0.8], [68, 0], [999, 0]];
  for (let i = 1; i < k.length; i++) if (h <= k[i][0]) return k[i - 1][1] + ((k[i][1] - k[i - 1][1]) * (h - k[i - 1][0])) / (k[i][0] - k[i - 1][0]);
  return 0;
}

const STORM_START = Date.UTC(2021, 1, 15, 0, 0); // Sun 14 Feb 18:00 CST
const STORM_HOURS = 114;
const READY_H = -57; // Fri 12 Feb 09:00
const SEC_PER_HOUR = [20, 10, 5, 2, 0.5];
const STEP_H = 5 / 60;
const COSTS: Record<BuyItem, number> = {
  protect: 1, generator: 2, warming_center: 1, keep_gas: 2, conservation: 1, repair_crews: 1, smart_switch: 2,
};

const TEMP: [number, number][] = [
  [0, 18], [6, 8], [13, -2], [20, 8], [30, 2], [37, -1], [44, 12], [54, 16], [62, 18], [68, 25],
  [78, 18], [85, 14], [92, 30], [102, 25], [110, 24], [114, 38],
];
const ORDER: [number, number][] = [
  [7.3, 0], [7.4, 700], [8, 1180], [10, 1300], [14, 1500], [20, 1350], [26, 1450], [30, 1600], [36, 1500],
  [40, 1400], [48, 1250], [54, 1100], [60, 950], [66, 800], [72, 700], [78, 600], [84, 450], [90, 300], [96, 0],
];

function interp(keys: [number, number][], h: number): number {
  if (h <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (h <= keys[i][0]) {
      const [h0, v0] = keys[i - 1], [h1, v1] = keys[i];
      return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
    }
  }
  return keys[keys.length - 1][1];
}

function cst(h: number): string {
  const d = new Date(STORM_START + h * 3600e3 - 6 * 3600e3);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00-06:00`;
}

const dur = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${Math.round(min % 60)} min` : ''}` : `${Math.round(min)} min`);

interface CS { on: boolean; protected: boolean; dark_min: number; indoor: number; restore_in: number | null; split: boolean; broken: boolean; cold: boolean }
interface BS { generator: boolean; protected: boolean; fuel: number }
type OpenEvent = GameEvent & { resolve: (option: string) => void };

class MockGame {
  phase: Phase;
  h: number;
  paused = true;
  speed = 3;
  points: number;
  cs: Record<string, CS> = {};
  bs: Record<string, BS> = {};
  event: OpenEvent | null = null;
  notices: Notice[] = [];
  private seq = 0;
  private shortMin = 0;
  private collapseMin = 0;
  private cph = 0;
  private lastOrder = 0;
  private waterDarkMin = 0;
  private boil = false;
  private boilEndH = -1;
  private gasBackH = -1e9;
  private gasWasOff = false;
  private warming = false;
  private emergencyConservationUntil = -1;
  private nextBreakH = 15;
  private rng = 11;
  prep = { keep_gas: false, conservation: false, repair_crews: false };

  constructor(phase: Phase, h0: number) {
    this.phase = phase;
    this.h = phase === 'ready' ? READY_H : h0;
    this.points = phase === 'ready' ? 10 : 2;
    for (const c of CIRCUITS) this.cs[c.id] = { on: true, protected: false, dark_min: 0, indoor: 68, restore_in: null, split: false, broken: false, cold: false };
    for (const b of BUILDINGS) this.bs[b.id] = { generator: false, protected: false, fuel: 0 };
    if (phase === 'storm') this.cs['C-02'].protected = true; // the 2021 playbook protects the hospital
  }

  private rand(): number { return (this.rng = (this.rng * 16807) % 2147483647) / 2147483647; }

  private notice(kind: NoticeKind, text: string, target?: string): void {
    this.notices = [...this.notices, { id: `n-${++this.seq}`, kind, text, target, time: cst(this.h) }].slice(-12);
  }

  private buildingOn(b: BuildingInfo): boolean {
    const s = this.bs[b.id];
    return this.cs[b.circuit].on || (s.generator && s.fuel > 0) || (b.id === 'gas-1' && this.prep.keep_gas);
  }

  private exposed(circuit: string): BuildingInfo | undefined {
    return BUILDINGS.find((b) => b.circuit === circuit && b.kind !== 'school' && !this.bs[b.id].generator && !(b.id === 'gas-1' && this.prep.keep_gas));
  }

  private doCut(id: string, minutes?: number): void {
    const c = this.cs[id];
    c.on = false;
    c.dark_min = 0;
    c.restore_in = minutes ?? null;
  }

  private doRestore(id: string): void {
    const c = this.cs[id];
    c.on = true;
    c.restore_in = null;
    c.broken = false;
  }

  apply(a: Action): void {
    switch (a.type) {
      case 'pause': this.paused = true; break;
      case 'play': if (!this.event && this.phase === 'storm') this.paused = false; break;
      case 'speed': this.speed = Math.min(5, Math.max(1, Math.round(a.value))); break;
      case 'start_storm':
        if (this.phase === 'ready') { this.phase = 'storm'; this.h = 0; this.paused = false; this.speed = 3; }
        break;
      case 'buy': case 'sell': this.buy(a.item, a.target, a.type === 'buy'); break;
      case 'cut': {
        const c = this.cs[a.circuit];
        if (!c || c.protected || this.phase !== 'storm') break;
        if (!c.on) { c.restore_in = a.minutes ?? null; break; }
        const b = this.exposed(a.circuit);
        if (b && !this.event) this.openBuildingEvent(b, a.circuit, a.minutes);
        else this.doCut(a.circuit, a.minutes);
        break;
      }
      case 'restore': if (this.cs[a.circuit]) this.doRestore(a.circuit); break;
      case 'emergency':
        if (a.item === 'generator' && a.target && this.bs[a.target] && this.points >= 2 && !this.bs[a.target].generator) {
          this.points -= 2; this.bs[a.target].generator = true; this.bs[a.target].fuel = 48;
          this.notice('info', `Backup generator sent to the ${BUILDINGS.find((b) => b.id === a.target)?.name.toLowerCase()}.`, a.target);
        } else if (a.item === 'warming_center' && this.points >= 1 && !this.warming) {
          this.points -= 1; this.warming = true;
          this.notice('info', 'Warming center opened at the South Dallas school.', 'school-1');
        } else if (a.item === 'conservation' && this.points >= 1) {
          this.points -= 1; this.emergencyConservationUntil = this.h + 24;
          this.notice('info', 'Conservation alert sent. Demand drops 0.5% for 24 hours.');
        }
        break;
      case 'choose':
        if (this.event && this.event.id === a.event) {
          const ev = this.event;
          this.event = null;
          ev.resolve(a.option);
          this.paused = false;
        }
        break;
    }
  }

  private buy(item: BuyItem, target: string, buying: boolean): void {
    if (this.phase !== 'ready') return;
    const cost = COSTS[item];
    if (buying && this.points < cost) return;
    const set = (has: boolean, apply: (v: boolean) => void) => {
      if (buying === has) return; // already in that state
      apply(buying);
      this.points += buying ? -cost : cost;
    };
    if (item === 'protect' && this.cs[target]) set(this.cs[target].protected, (v) => (this.cs[target].protected = v));
    else if (item === 'smart_switch' && this.cs[target]) set(this.cs[target].split, (v) => (this.cs[target].split = v));
    else if (item === 'generator' && this.bs[target]) set(this.bs[target].generator, (v) => { this.bs[target].generator = v; this.bs[target].fuel = v ? 48 : 0; });
    else if (item === 'warming_center') set(this.warming, (v) => (this.warming = v));
    else if (item === 'keep_gas' || item === 'conservation' || item === 'repair_crews') set(this.prep[item], (v) => (this.prep[item] = v));
  }

  private openBuildingEvent(b: BuildingInfo, circuit: string, minutes?: number): void {
    const texts: Record<string, [string, string]> = {
      water: ['The water plant is about to lose power.', 'Without it, about 180,000 people lose water pressure in 2 hours.'],
      hospital: ['The hospital is about to lose power.', `Its circuit, ${circuit}, also serves ${CIRCUIT_BY_ID[circuit].people.toLocaleString('en-US')} people.`],
      gas: ['The gas compressor is about to lose power.', 'Without it, the gas power plant loses fuel and every cut order grows 15%.'],
      clinic: ['The dialysis center is about to lose power.', 'Its patients need treatment every few days. A long outage puts them at risk.'],
    };
    const [title, text] = texts[b.kind] ?? [`The ${b.name} is about to lose power.`, ''];
    const canGen = this.points >= 2;
    this.event = {
      id: `ev-${++this.seq}`,
      title, text, target: b.id,
      options: [
        { id: 'gen', label: 'Send a backup generator (2 pts)', ai_pick: canGen },
        { id: 'other', label: 'Cut a different neighborhood', ai_pick: !canGen },
        { id: 'dark', label: `Let the ${b.name.toLowerCase().split(' ·')[0]} go dark`, ai_pick: false },
      ],
      resolve: (opt) => {
        if (opt === 'gen' && this.points >= 2) {
          this.points -= 2; this.bs[b.id].generator = true; this.bs[b.id].fuel = 48;
          this.doCut(circuit, minutes);
        } else if (opt === 'dark') this.doCut(circuit, minutes);
        else this.notice('info', `Cut of ${circuit} cancelled. Pick another neighborhood.`, circuit);
      },
    };
    this.paused = true;
  }

  private openShortEvent(short: number): void {
    this.event = {
      id: `ev-${++this.seq}`,
      title: 'You are short of the cut order.',
      text: `The grid needs ${Math.round(short)} MW more. If the cut stays more than 30% short for 30 minutes, the grid collapses.`,
      options: [
        { id: 'auto', label: 'Cut the warmest neighborhood for 1 h', ai_pick: true },
        { id: 'hold', label: 'Hold for 15 minutes', ai_pick: false },
      ],
      resolve: (opt) => {
        this.shortMin = 0;
        if (opt !== 'auto') return;
        const pick = CIRCUITS.filter((c) => this.cs[c.id].on && !this.cs[c.id].protected && !this.exposed(c.id))
          .sort((a, b) => this.cs[b.id].indoor - this.cs[a.id].indoor)[0];
        if (pick) this.doCut(pick.id, 60);
      },
    };
    this.paused = true;
  }

  get order(): number {
    if (this.phase !== 'storm') return 0;
    const gasMult = this.gasWasOff || this.h < this.gasBackH + 2 ? 1.15 : 1;
    const cons = (this.prep.conservation && this.h < 24 ? 0.97 : 1) * (this.h < this.emergencyConservationUntil ? 0.995 : 1);
    return Math.round((interp(ORDER, this.h) * gasMult * cons) / 5) * 5;
  }

  get cut(): number {
    return CIRCUITS.reduce((s, c) => s + (this.cs[c.id].on ? 0 : c.mw), 0);
  }

  step(): void {
    const dt = STEP_H;
    this.h += dt;
    const out = interp(TEMP, this.h);
    for (const c of CIRCUITS) {
      const s = this.cs[c.id];
      if (s.on) {
        s.indoor = 68 + (s.indoor - 68) * Math.exp(-dt / 2);
        if (s.indoor >= 55) s.cold = false;
        continue;
      }
      const tau = c.v >= 0.7 ? 7 : 10;
      s.indoor = out + (s.indoor - out) * Math.exp(-dt / tau);
      s.dark_min += 5;
      if (s.indoor < 50 && !s.cold) { s.cold = true; this.notice('cold', `${c.area} (${c.id}) homes dropped below 50°F.`, c.id); }
      if (s.restore_in != null) {
        s.restore_in -= 5;
        if (s.restore_in <= 0) {
          const was = s.dark_min, broken = s.broken;
          this.doRestore(c.id);
          this.notice(broken ? 'repair' : 'restore', broken ? `Crews fixed the ice-broken line in ${c.area} (${c.id}).` : `${c.area} (${c.id}) is back on after ${dur(was)}.`, c.id);
        }
      }
    }

    // ice line breaks, about one every 12 hours
    if (this.h >= this.nextBreakH && this.h < 96) {
      this.nextBreakH += 10 + this.rand() * 4;
      const pool = CIRCUITS.filter((c) => this.cs[c.id].on && !this.cs[c.id].protected && !c.building);
      const c = pool[Math.floor(this.rand() * pool.length)];
      if (c) {
        this.doCut(c.id, this.prep.repair_crews ? 120 : 360);
        this.cs[c.id].broken = true;
        this.notice('ice', `Ice broke a line in ${c.area} (${c.id}). Repair takes ${this.prep.repair_crews ? 2 : 6} h.`, c.id);
      }
    }

    // generators burn fuel while their circuit is dark
    for (const b of BUILDINGS) {
      const s = this.bs[b.id];
      if (s.generator && !this.cs[b.circuit].on) {
        s.fuel -= dt;
        if (s.fuel <= 0) { s.generator = false; s.fuel = 0; this.notice('info', `The ${b.name.toLowerCase()} generator ran out of fuel.`, b.id); }
      }
    }

    // water and gas links
    const water = BUILDINGS.find((b) => b.id === 'water-1')!;
    if (!this.buildingOn(water)) {
      this.waterDarkMin += 5;
      if (this.waterDarkMin >= 120 && !this.boil) { this.boil = true; this.boilEndH = Infinity; this.notice('water', 'Boil-water notice for 180,000 people.', 'water-1'); }
    } else {
      this.waterDarkMin = 0;
      if (this.boil && this.boilEndH === Infinity) this.boilEndH = this.h + 24;
      if (this.boil && this.h >= this.boilEndH) { this.boil = false; this.notice('water', 'Boil-water notice lifted.', 'water-1'); }
    }
    const gasOn = this.buildingOn(BUILDINGS.find((b) => b.id === 'gas-1')!);
    if (!gasOn && !this.gasWasOff) { this.gasWasOff = true; this.notice('gas', 'The gas compressor lost power. Cut orders grow 15%.', 'gas-1'); }
    if (gasOn && this.gasWasOff) { this.gasWasOff = false; this.gasBackH = this.h; }

    // the order and the shortfall rules
    const order = this.order, cut = this.cut;
    if (order - this.lastOrder > 200) { this.notice('order', `The grid operator raised the order to ${order.toLocaleString('en-US')} MW.`); this.lastOrder = order; }
    if (order < this.lastOrder) this.lastOrder = order;
    const short = order - cut;
    this.shortMin = order > 0 && short > order * 0.05 ? this.shortMin + 5 : 0;
    this.collapseMin = order > 0 && short > order * 0.3 ? this.collapseMin + 5 : 0;
    if (this.collapseMin === 30) this.notice('info', 'The cut has been more than 30% short for 30 minutes. In the real game the grid collapses here.');
    if (this.shortMin >= 15 && !this.event) this.openShortEvent(short);

    // cold person-hours
    for (const c of CIRCUITS) {
      const s = this.cs[c.id];
      if (!s.on && s.indoor < 50) this.cph += c.people * dt * (1 + c.v);
    }

    if (this.h >= STORM_HOURS) { this.phase = 'over'; this.paused = true; }
  }

  snapshot(): GameState {
    const out = this.phase === 'ready' ? 34 : Math.round(interp(TEMP, this.h));
    let noPower = 0, cold = 0;
    for (const c of CIRCUITS) {
      const s = this.cs[c.id];
      if (!s.on) { noPower += c.people; if (s.indoor < 50) cold += c.people; }
    }
    if (this.warming) cold = Math.max(0, cold - 20000);
    // co-pilot: the dark neighborhood closest to turning cold
    let tip: { tip: string; target?: string } | null = null;
    const outF = interp(TEMP, this.h);
    let best = Infinity;
    for (const c of CIRCUITS) {
      const s = this.cs[c.id];
      if (s.on || s.indoor < 50 || s.indoor - outF <= 0) continue;
      const tau = c.v >= 0.7 ? 7 : 10;
      const hrs = -tau * Math.log((50 - outF) / (s.indoor - outF));
      if (hrs < best) { best = hrs; tip = { tip: `${c.id} crosses 50°F inside in about ${dur(Math.max(5, Math.round((hrs * 60) / 5) * 5))}.`, target: c.id }; }
    }
    if (!tip && this.phase === 'ready' && !this.bs['water-1'].generator) {
      tip = { tip: 'The water plant has no backup power. Place a generator here, or save 2 points for the storm.', target: 'water-1' };
    }
    const ev = this.event ? { id: this.event.id, title: this.event.title, text: this.event.text, options: this.event.options, target: this.event.target } : null;
    return {
      time: cst(this.h),
      phase: this.phase,
      paused: this.paused || !!this.event || this.phase !== 'storm',
      speed: this.speed,
      outside_f: out,
      order_mw: this.order,
      cut_mw: this.cut,
      points: this.points,
      circuits: CIRCUITS.map((c) => {
        const s = this.cs[c.id];
        return {
          id: c.id, area: c.area, on: s.on, protected: s.protected, dark_min: s.dark_min,
          indoor_f: Math.round(s.indoor * 10) / 10, people: c.people, mw: c.mw, split: s.split,
          broken: s.broken, restore_in_min: s.restore_in,
        };
      }),
      buildings: BUILDINGS.map((b) => {
        const s = this.bs[b.id];
        const on = this.buildingOn(b);
        return {
          id: b.id, type: b.type, circuit: b.circuit, on, generator: s.generator, protected: s.protected,
          at_risk: !on || (this.event?.target === b.id), fuel_h: s.generator ? Math.round(s.fuel) : undefined,
        };
      }),
      totals: { people_no_power: noPower, people_cold: cold, cold_person_hours: Math.round(this.cph) },
      event: ev,
      copilot: tip,
      effects: {
        gas_multiplier: this.gasWasOff || this.h < this.gasBackH + 2 ? 1.15 : 1,
        boil_water_people: this.boil ? 180000 : 0,
        conservation: (this.prep.conservation && this.h < 24) || this.h < this.emergencyConservationUntil,
      },
      prep: { ...this.prep, warming_center: this.warming },
      notices: this.notices,
      weather: { snow: snowAt(this.h) },
    };
  }

  /** For screenshots and the video: start with these circuits dark, `hours` into their outage. */
  preCut(ids: string[], hours: number): void {
    for (const id of ids) if (this.cs[id] && !this.cs[id].protected) this.doCut(id);
    const steps = Math.round(hours * 12);
    for (let i = 0; i < steps && !this.event; i++) this.step();
    this.notices = [];
  }

  /** Real seconds per 5-minute step at the current speed. */
  get stepSeconds(): number {
    return SEC_PER_HOUR[this.speed - 1] / 12;
  }
}

export function mockLink(): GameLink {
  const q = new URLSearchParams(location.search);
  const phase = (q.get('phase') as Phase) || 'storm';
  const h0 = Number(q.get('t') ?? 6);
  const game = new MockGame(phase === 'ready' ? 'ready' : 'storm', Number.isFinite(h0) ? h0 : 6);
  const pre = q.get('cut');
  if (pre && game.phase === 'storm') game.preCut(pre.split(','), Number(q.get('dark') ?? 3));
  let timer: ReturnType<typeof setInterval> | undefined;
  let emit: (s: GameState) => void = () => {};
  let acc = 0;
  return {
    kind: 'mock',
    start(onState, onStatus) {
      emit = onState;
      onStatus(true);
      onState(game.snapshot());
      let last = performance.now();
      timer = setInterval(() => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        if (game.paused || game.event || game.phase !== 'storm') { acc = 0; return; }
        acc += dt;
        let stepped = false;
        while (acc >= game.stepSeconds && game.phase === 'storm' && !game.event) { game.step(); acc -= game.stepSeconds; stepped = true; }
        if (stepped) emit(game.snapshot());
      }, 40);
    },
    send(a) {
      game.apply(a);
      emit(game.snapshot());
    },
    stop() { clearInterval(timer); },
  };
}
