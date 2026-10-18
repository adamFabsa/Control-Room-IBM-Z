// Shapes shared with the engine (Person 1) and server (Adam). See spec "Shared contracts".
// Fields marked optional are 1B's requested additions; the UI works without them.

export type Phase = 'ready' | 'storm' | 'over';

export interface Circuit {
  id: string;
  area: string;
  on: boolean;
  protected: boolean;
  dark_min: number;
  indoor_f: number;
  people: number;
  mw: number;
  split: boolean;
  parent?: string;
  broken?: boolean;
  restore_in_min?: number | null;
  medical?: number;
}

export interface Building {
  id: string;
  type: string;
  circuit: string;
  on: boolean;
  generator: boolean;
  protected: boolean;
  at_risk?: boolean;
  fuel_h?: number;
}

export interface EventOption {
  id: string;
  label: string;
  ai_pick: boolean;
  /** M2 (Snap ML on LinuxONE): what this option does over the next 6 game hours */
  m2?: { cold_person_hours_change: number; critical_dark_chance: number; grid_collapse_risk?: boolean } | null;
}

export interface GameEvent {
  id: string;
  title: string;
  text: string;
  options: EventOption[];
  target?: string;
  kind?: string;
  /** Granite's rewrite of the card, once it passes the server's number check */
  ai_text?: string;
}

export type NoticeKind = 'cold' | 'order' | 'ice' | 'repair' | 'restore' | 'water' | 'gas' | 'info';

export interface Notice {
  id: string;
  kind: NoticeKind;
  text: string;
  target?: string;
  time?: string;
}

export interface GameState {
  time: string;
  phase?: Phase;
  paused: boolean;
  speed: number;
  outside_f: number;
  order_mw: number;
  cut_mw: number;
  points: number;
  circuits: Circuit[];
  buildings: Building[];
  totals: { people_no_power: number; people_cold: number; cold_person_hours: number };
  event: GameEvent | null;
  copilot?: { tip: string; target?: string } | null;
  effects?: { gas_multiplier?: number; boil_water_people?: number; conservation?: boolean };
  prep?: { keep_gas?: boolean; conservation?: boolean; repair_crews?: boolean; warming_center?: boolean };
  notices?: Notice[];
  weather?: { snow?: number };
  /** quick play: the clock is fast-forwarding (no cut order, every neighborhood has power) */
  fast_forward?: boolean;
  warming_centers?: string[];
  quick?: boolean;
}

export type BuyItem =
  | 'protect'
  | 'generator'
  | 'warming_center'
  | 'keep_gas'
  | 'conservation'
  | 'repair_crews'
  | 'smart_switch';

export type EmergencyItem = 'generator' | 'warming_center' | 'conservation';

export type Action =
  | { type: 'buy'; item: BuyItem; target: string }
  | { type: 'sell'; item: BuyItem; target: string }
  | { type: 'start_storm' }
  | { type: 'cut'; circuit: string; minutes?: number }
  | { type: 'restore'; circuit: string }
  | { type: 'emergency'; item: EmergencyItem; target?: string }
  | { type: 'choose'; event: string; option: string }
  | { type: 'pause' }
  | { type: 'play' }
  | { type: 'speed'; value: number }
  | { type: 'new_game'; storm?: string; seed?: number; demo?: boolean };

export interface ScoreSet {
  cold_person_hours: number;
  longest_outage_min?: number;
  critical_dark_min?: number;
  water_plants_lost?: number;
  orders_met_pct?: number;
  boil_water_person_hours?: number;
}

export interface Report {
  storm: string;
  beat_playbook?: boolean;
  scores: { playbook_2021: ScoreSet; ai_alone: ScoreSet; player: ScoreSet };
  cold_people_by_hour?: { t: string[]; playbook_2021: number[]; ai_alone: number[]; player: number[] };
  turning_points?: {
    time: string | null; action: Action; delta_cold_person_hours: number;
    label?: string; cold_person_hours_change?: number; grid_collapsed_without?: boolean; grid_collapsed?: boolean;
  }[];
  turning_points_run?: { replays: number; seconds: number; cores: number } | null;
  summary?: string;
  summary_source?: 'pending' | 'template' | 'granite';
  plan?: string[];
  stress_test?: { storms: number; works: number; worst: string; seconds?: number; cores?: number; collapses?: number };
  stress_test_progress?: { status?: string; done?: number; storms?: number };
  no_power_by_hour?: { t: string[]; playbook_2021: number[]; ai_alone: number[]; player: number[] };
  /** every hourly series for the data explorer: per game (by) or one shared line (weather, demand) */
  series?: {
    t: string[];
    games: Record<string, string>;
    metrics: {
      id: string; label: string; unit: string;
      by?: Record<'player' | 'playbook_2021' | 'ai_alone', (number | null)[]>;
      shared?: (number | null)[];
      reference?: { label: string; values: (number | null)[] };
    }[];
  };
  /** DSHS's 22 Dallas County deaths in 2021, scaled by each game's hours in cold homes; null after a grid collapse */
  estimated_deaths?: { player: number | null; playbook_2021: number; ai_alone: number | null; method: string; source: string; source_url: string };
  game_check?: string;
}
