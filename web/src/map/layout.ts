// Real Dallas County, from Census TIGER tracts and CDC SVI (see tools/prep-dallas.mjs).
// Game numbers (people, MW, vulnerability) are the spec's; positions and shapes are real.
// World units: x east, z south; 1 unit = 0.6 mi.
import GEN from './dallas.gen.json';
import type { Rect } from './iso';

export interface CircuitInfo {
  id: string;
  area: string;
  people: number;
  mw: number;
  v: number; // vulnerability used by the game (spec)
  center: [number, number];
  realPop: number; // population of its real census tracts
  svi: number | null; // CDC SVI 2022, population-weighted over its tracts
  covers: string[]; // suburbs this circuit reaches into
  building?: string;
  towers?: boolean;
}

export type BuildingKind = 'hospital' | 'clinic' | 'water' | 'gas' | 'school';

export interface BuildingInfo {
  id: string;
  name: string;
  type: string;
  circuit: string;
  kind: BuildingKind;
  at: [number, number];
  rect: Rect;
  h: number;
}

type GenCircuit = { center: [number, number]; realPop: number; svi: number | null; covers: string[] };
const G = GEN as unknown as {
  units: { miPerUnit: number; w: number; h: number; lon: [number, number]; lat: [number, number] };
  circuits: Record<string, GenCircuit>;
  buildings: Record<string, [number, number]>;
  towers: [number, number, number][];
  reunion: [number, number]; plant: [number, number]; waterTower: [number, number]; hub: [number, number];
  lamps: [number, number, number][];
  places: { name: string; x: number; z: number }[];
  campuses?: { name: string; x: number; z: number }[];
  landmarks?: { name: string; x: number; z: number }[];
};

export const WORLD = { w: G.units.w, h: G.units.h, miPerUnit: G.units.miPerUnit };
/** World position (x east, z south) of a real latitude/longitude. */
export function LL(lat: number, lon: number): [number, number] {
  const [lon0, lon1] = G.units.lon, [lat0, lat1] = G.units.lat;
  return [((lon - lon0) / (lon1 - lon0)) * G.units.w, ((lat1 - lat) / (lat1 - lat0)) * G.units.h];
}

const SPEC: Omit<CircuitInfo, 'center' | 'realPop' | 'svi' | 'covers'>[] = [
  { id: 'C-01', area: 'Downtown', people: 100000, mw: 250, v: 0.3, towers: true },
  { id: 'C-02', area: 'Medical District', people: 120000, mw: 300, v: 0.55, building: 'hospital-1' },
  { id: 'C-03', area: 'Southwest Dallas', people: 160000, mw: 400, v: 0.7, building: 'dialysis-1' },
  { id: 'C-04', area: 'East Dallas', people: 160000, mw: 400, v: 0.6, building: 'water-1' },
  { id: 'C-05', area: 'West Dallas', people: 140000, mw: 350, v: 0.7, building: 'gas-1' },
  { id: 'C-06', area: 'South Dallas', people: 180000, mw: 450, v: 0.75, building: 'school-1' },
  { id: 'C-07', area: 'Oak Cliff', people: 200000, mw: 500, v: 0.75 },
  { id: 'C-08', area: 'Oak Cliff', people: 200000, mw: 500, v: 0.75 },
  { id: 'C-09', area: 'Oak Cliff', people: 200000, mw: 500, v: 0.75 },
  { id: 'C-10', area: 'Lake Highlands', people: 180000, mw: 450, v: 0.45 },
  { id: 'C-11', area: 'Lake Highlands', people: 180000, mw: 450, v: 0.45 },
  { id: 'C-12', area: 'Lake Highlands', people: 180000, mw: 450, v: 0.45 },
  { id: 'C-13', area: 'Pleasant Grove', people: 200000, mw: 500, v: 0.85 },
  { id: 'C-14', area: 'Pleasant Grove', people: 200000, mw: 500, v: 0.85 },
  { id: 'C-15', area: 'Pleasant Grove', people: 200000, mw: 500, v: 0.85 },
];

export const CIRCUITS: CircuitInfo[] = SPEC.map((c) => ({ ...c, ...G.circuits[c.id] }));
export const CIRCUIT_BY_ID: Record<string, CircuitInfo> = Object.fromEntries(CIRCUITS.map((c) => [c.id, c]));

const B = (id: string, name: string, type: string, circuit: string, kind: BuildingKind, size: number, h: number): BuildingInfo => {
  const at = G.buildings[id];
  return { id, name, type, circuit, kind, at, rect: [at[0] - size / 2, at[1] - size / 2, size, size], h };
};
export const BUILDINGS: BuildingInfo[] = [
  B('hospital-1', 'Hospital', 'hospital', 'C-02', 'hospital', 1.5, 1.1),
  B('dialysis-1', 'Dialysis center', 'dialysis', 'C-03', 'clinic', 0.9, 0.55),
  B('water-1', 'Water plant', 'water_plant', 'C-04', 'water', 1.5, 0.6),
  B('gas-1', 'Gas compressor', 'gas_compressor', 'C-05', 'gas', 0.9, 0.5),
  B('school-1', 'School · warming site', 'school', 'C-06', 'school', 1.4, 0.65),
];
export const BUILDING_BY_ID: Record<string, BuildingInfo> = Object.fromEntries(BUILDINGS.map((b) => [b.id, b]));

export const LAMPS: { x: number; z: number; circuit: string }[] = G.lamps.map(([x, z, k]) => ({ x, z, circuit: CIRCUITS[k].id }));
export const TOWERS = G.towers.map(([x, z, h]) => ({ x, z, h }));
export const REUNION = G.reunion;
export const POWER_PLANT = G.plant;
export const WATER_TOWER = G.waterTower;
export const HUB = G.hub;

export type LabelKind = 'area' | 'place' | 'water' | 'campus' | 'landmark';
/** One label per area (averaged over its circuits), real place names, campuses and landmarks. */
export const AREA_LABELS: { text: string; x: number; y: number; minor?: boolean; kind: LabelKind; minZoom: number }[] = (() => {
  const byArea = new Map<string, [number, number, number]>();
  for (const c of CIRCUITS) {
    const a = byArea.get(c.area) ?? [0, 0, 0];
    byArea.set(c.area, [a[0] + c.center[0], a[1] + c.center[1], a[2] + 1]);
  }
  const areas = [...byArea].map(([text, [x, y, n]]) => ({ text, x: x / n, y: y / n + 1.0, kind: 'area' as const, minZoom: 0 }));
  const places = G.places.map((p) => ({ text: p.name, x: p.x, y: p.z, minor: true, kind: /Lake|River/.test(p.name) ? 'water' as const : 'place' as const, minZoom: 1.15 }));
  const campuses = (G.campuses ?? []).map((c) => ({ text: c.name, x: c.x, y: c.z, minor: true, kind: 'campus' as const, minZoom: 2.2 }));
  const landmarks = (G.landmarks ?? []).map((l) => ({ text: l.name, x: l.x, y: l.z, minor: true, kind: 'landmark' as const, minZoom: l.name === 'Dallas Hall' ? 14 : 6 }));
  return [...areas, ...places, ...campuses, ...landmarks];
})();
