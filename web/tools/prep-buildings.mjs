// Turns the real OpenStreetMap building outlines of Dallas County into compact files for the game,
// at true size and in their real places, plus trees in yards, woods and along creeks.
// Run after prep-dallas.mjs and fetch-osm.mjs:   node tools/prep-buildings.mjs
// Outputs (public/geo):
//   rects.bin    simple buildings as oriented boxes: Uint16 × 8 each (see RECT below), ~95% of them
//   polys.bin    large irregular buildings as real outlines (towers, campus halls, malls)
//   trees.bin    trees: Uint16 × 3 each (x, z, crown size in cm)
//   buildings.json  chunk index for both, named campuses and landmarks
// Footprints missing from OpenStreetMap, and heights, come from Microsoft's Global ML Building Footprints
// (data/msbuildings, see README). Data © OpenStreetMap contributors and Microsoft (both ODbL).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const OSM = new URL('../../data/osm/', import.meta.url).pathname;
const PUB = new URL('../public/geo/', import.meta.url).pathname;
const GEN = JSON.parse(readFileSync(new URL('../src/map/dallas.gen.json', import.meta.url)));
const BIG = JSON.parse(readFileSync(`${PUB}dallas.json`));
const { w: W, h: H, lon: [LON0, LON1], lat: [LAT0, LAT1] } = GEN.units;
const M = GEN.units.miPerUnit * 1609.344; // meters per world unit
const P = (lon, lat) => [((lon - LON0) / (LON1 - LON0)) * W, ((LAT1 - lat) / (LAT1 - LAT0)) * H];
const LL = (lat, lon) => P(lon, lat);

// ---------- helpers ----------
const hash = (n) => { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
let seed = 20210214;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (x, z, poly) => pointInRing(x, z, poly[0]) && !poly.slice(1).some((h) => pointInRing(x, z, h));
const bboxOf = (ring) => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [x, z] of ring) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); } return [a, b, c, d]; };
const area = (ring) => { let s = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]); return s / 2; };
function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** Smallest rectangle around the points: centre, long-side angle in [0, π), long and short side. */
function minRect(pts) {
  const h = hull(pts);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const [ax, az] = h[i], [bx, bz] = h[(i + 1) % h.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-9) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of h) { const u = x * ux + z * uz, v = -x * uz + z * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const a = (u1 - u0) * (v1 - v0);
    if (!best || a < best.a) best = { a, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { ux, uz, u0, u1, v0, v1 } = best;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  let cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
  let w = u1 - u0, d = v1 - v0, ang = Math.atan2(uz, ux);
  if (d > w) { [w, d] = [d, w]; ang += Math.PI / 2; }
  ang = ((ang % Math.PI) + Math.PI) % Math.PI;
  return { cx, cz, w, d, ang, area: best.a };
}
function dp(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    let bestD = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const dd = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
      if (dd > bestD) { bestD = dd; bi = i; }
    }
    if (bestD > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
const num = (v) => { if (v == null) return NaN; const m = String(v).match(/[\d.]+/); if (!m) return NaN; const n = parseFloat(m[0]); return /ft|'/.test(v) ? n * 0.3048 : n; };

/** A uniform grid of world-space items for neighbor queries. */
class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return i * 100003 + j; }
  add(x, z, r, item) {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
      const k = this.key(i, j);
      let a = this.map.get(k);
      if (!a) this.map.set(k, (a = []));
      a.push(item);
    }
  }
  near(x, z) { return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? []; }
}

// ---------- the county and its circuits ----------
const county = BIG.county;
const inCounty = (x, z) => county.some((poly) => inPoly(x, z, poly));
const plates = Object.entries(BIG.plates).map(([id, polys]) => ({ id, polys, box: bboxOf(polys.flatMap((p) => p[0])) }));
const CIRCUIT_IDS = Object.keys(GEN.circuits);
const circuitAt = (x, z) => {
  for (const p of plates) {
    if (x < p.box[0] || x > p.box[2] || z < p.box[1] || z > p.box[3]) continue;
    if (p.polys.some((poly) => inPoly(x, z, poly))) return CIRCUIT_IDS.indexOf(p.id);
  }
  return -1;
};
const lakeBoxes = BIG.lakes.map((poly) => ({ poly, box: bboxOf(poly[0]) }));
const inLake = (x, z) => lakeBoxes.some(({ poly, box }) => x > box[0] && x < box[2] && z > box[1] && z < box[3] && inPoly(x, z, poly));

// places the game draws itself; real buildings there step aside
const clear = [
  ...Object.values(GEN.buildings).map(([x, z]) => [x, z, 0.16]),
  [...GEN.reunion, 0.03], [...GEN.plant, 0.3], [...GEN.hub, 0.12], [...GEN.waterTower, 0.04],
  [...LL(32.7766, -96.7612), 0.05], // Texas Star
];
const cleared = (x, z) => clear.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r);

// ---------- campuses and named areas ----------
const ringsOf = (el) => {
  if (el.type === 'way') return el.geometry ? [[el.geometry.map((g) => P(g.lon, g.lat))]] : [];
  if (el.type !== 'relation') return [];
  // join member ways into closed rings
  const join = (role) => {
    const parts = (el.members ?? []).filter((m) => m.type === 'way' && m.role === role && m.geometry).map((m) => m.geometry.map((g) => P(g.lon, g.lat)));
    const rings = [];
    const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
    while (parts.length) {
      let ring = parts.shift();
      for (let guard = 0; !same(ring[0], ring[ring.length - 1]) && guard < 500; guard++) {
        const k = parts.findIndex((p) => same(p[0], ring[ring.length - 1]) || same(p[p.length - 1], ring[ring.length - 1]));
        if (k < 0) break;
        const p = parts.splice(k, 1)[0];
        ring = ring.concat(same(p[0], ring[ring.length - 1]) ? p.slice(1) : p.reverse().slice(1));
      }
      if (ring.length >= 4) rings.push(ring);
    }
    return rings;
  };
  const outers = join('outer'), inners = join('inner');
  if (!outers.length && el.bounds) { // Overpass sometimes returns a big relation with only its bounds
    const { minlat, minlon, maxlat, maxlon } = el.bounds;
    return [[[P(minlon, maxlat), P(maxlon, maxlat), P(maxlon, minlat), P(minlon, minlat), P(minlon, maxlat)]]];
  }
  return outers.map((o) => [o, ...inners.filter((i) => pointInRing(i[0][0], i[0][1], o))]);
};
const areasRaw = JSON.parse(readFileSync(`${OSM}areas.json`)).elements;
const campuses = [], woods = [];
for (const el of areasRaw) {
  const t = el.tags ?? {};
  const polys = ringsOf(el);
  if (!polys.length) continue;
  if (t.amenity === 'university' || t.amenity === 'college') {
    const a = polys.reduce((s, p) => s + Math.abs(area(p[0])), 0) * M * M;
    campuses.push({ name: t.name ?? '', polys, box: bboxOf(polys.flatMap((p) => p[0])), a, smu: /Southern Methodist/.test(t.name ?? '') });
  } else if (t.landuse === 'forest' || t.natural === 'wood') woods.push({ polys, box: bboxOf(polys.flatMap((p) => p[0])) });
}
const campusAt = (x, z) => campuses.find((c) => x > c.box[0] && x < c.box[2] && z > c.box[1] && z < c.box[3] && c.polys.some((p) => inPoly(x, z, p)));

// ---------- buildings ----------
// kinds (shared with src/map3d/buildings.ts)
const HOUSE = 0, APT = 1, COM = 2, IND = 3, CIVIC = 4, UNI = 5, TOWER = 6, SMALL = 7;
const FLAT = 0, GABLE = 1, HIP = 2;
const TYPE = {
  house: HOUSE, detached: HOUSE, semidetached_house: HOUSE, terrace: HOUSE, bungalow: HOUSE, cabin: HOUSE, farm: HOUSE, static_caravan: HOUSE,
  apartments: APT, dormitory: APT,
  commercial: COM, retail: COM, office: COM, hotel: COM, supermarket: COM, kiosk: COM, bank: COM,
  industrial: IND, warehouse: IND, factory: IND, manufacture: IND, hangar: IND, service: IND, transportation: IND, storage_tank: IND, data_center: IND,
  school: CIVIC, church: CIVIC, chapel: CIVIC, cathedral: CIVIC, mosque: CIVIC, temple: CIVIC, synagogue: CIVIC, religious: CIVIC, hospital: CIVIC,
  public: CIVIC, government: CIVIC, civic: CIVIC, fire_station: CIVIC, library: CIVIC, museum: CIVIC, stadium: CIVIC, sports_centre: CIVIC, grandstand: CIVIC,
  kindergarten: CIVIC, train_station: CIVIC, parking: IND,
  university: UNI, college: UNI,
  garage: SMALL, garages: SMALL, shed: SMALL, carport: SMALL, roof: SMALL, greenhouse: SMALL, barn: SMALL, stable: SMALL, hut: SMALL,
};
const ROOF_TAG = { flat: FLAT, gabled: GABLE, hipped: HIP, pyramidal: HIP, 'half-hipped': HIP, side_hipped: HIP, gambrel: GABLE, mansard: HIP, saltbox: GABLE };

const seen = new Set();
const rects = [], polys = [];
const named = [];
let skipped = 0;
const why = { cleared: 0, lake: 0, noCircuit: 0 }, whyAt = [];
/** Is this footprint somewhere the game can draw it? */
const placeable = (cx, cz) => {
  if (cx < 0 || cz < 0 || cx > W || cz > H || !inCounty(cx, cz)) { skipped++; return -1; }
  if (cleared(cx, cz)) { why.cleared++; skipped++; return -1; }
  if (inLake(cx, cz)) { why.lake++; skipped++; whyAt.push(['lake', cx, cz]); return -1; }
  const k = circuitAt(cx, cz);
  if (k < 0) { why.noCircuit++; skipped++; whyAt.push(['circuit', cx, cz]); return -1; }
  return k;
};

// pass 1: OpenStreetMap (names, types, mapped heights)
const raw = [];
const files = readdirSync(OSM).filter((f) => /^b_\d+_\d+\.json$/.test(f)).sort();
for (const f of files) {
  const els = JSON.parse(readFileSync(`${OSM}${f}`)).elements;
  for (const el of els) {
    const key = `${el.type}${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = el.tags ?? {};
    if (!t.building || t.building === 'no' || t.building === 'construction' || t['building:part']) continue;
    for (const poly of ringsOf(el)) {
      const outer = poly[0];
      if (outer.length < 4) continue;
      const rect = minRect(outer);
      if (!rect) continue;
      const aM = Math.abs(area(outer)) * M * M;
      if (aM < 12) continue; // sheds below this are noise at any zoom
      const k = placeable(rect.cx, rect.cz);
      if (k < 0) continue;
      raw.push({ poly, rect, aM, k, t, id: el.id, src: 0, box: bboxOf(outer), tagH: num(t.height) > 0 || num(t['building:levels']) > 0 });
    }
  }
}
const nOsm = raw.length;
console.log(`OpenStreetMap: ${nOsm} buildings`);

// pass 2: Microsoft's footprints (ODbL) fill what OpenStreetMap hasn't traced, and give estimated heights
{
  const grid = new Grid(0.02);
  raw.forEach((b, i) => { const [x0, z0, x1, z1] = b.box; grid.add((x0 + x1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0) / 2, i); });
  const MS = new URL('../../data/msbuildings/', import.meta.url).pathname;
  const { createReadStream } = await import('node:fs');
  const { createGunzip } = await import('node:zlib');
  const { createInterface } = await import('node:readline');
  let added = 0, heights = 0, n = 0;
  const msFiles = existsSync(MS) ? readdirSync(MS).filter((f) => f.endsWith('.csv.gz')) : [];
  for (const f of msFiles) {
    const rl = createInterface({ input: createReadStream(`${MS}${f}`).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.startsWith('{')) continue;
      // quick reject on the first coordinate before parsing
      const m = line.match(/"coordinates": \[\[\[(-?[\d.]+), (-?[\d.]+)/);
      if (!m) continue;
      const lon = +m[1], lat = +m[2];
      if (lon < LON0 - 0.01 || lon > LON1 + 0.01 || lat < LAT0 - 0.01 || lat > LAT1 + 0.01) continue;
      const feat = JSON.parse(line);
      if (feat.geometry.type !== 'Polygon') continue;
      n++;
      const outer = feat.geometry.coordinates[0].map(([lo, la]) => P(lo, la));
      const aM = Math.abs(area(outer)) * M * M;
      if (aM < 25) continue;
      let cx = 0, cz = 0;
      for (const [x, z] of outer) { cx += x; cz += z; }
      cx /= outer.length; cz /= outer.length;
      const msH = feat.properties.height > 0 ? feat.properties.height : 0;
      // the same building in OpenStreetMap? (either centroid inside the other's outline)
      let match = -1;
      const box = bboxOf(outer);
      for (const i of grid.near(cx, cz)) {
        const b = raw[i];
        if (b.box[0] > box[2] || b.box[2] < box[0] || b.box[1] > box[3] || b.box[3] < box[1]) continue;
        if (pointInRing(cx, cz, b.poly[0]) || pointInRing(b.rect.cx, b.rect.cz, outer)) { match = i; break; }
      }
      if (match >= 0) {
        const b = raw[match];
        if (!b.tagH && msH > 0) { b.msH = Math.max(b.msH ?? 0, msH); heights++; }
        continue;
      }
      const rect = minRect(outer);
      if (!rect) continue;
      const k = placeable(rect.cx, rect.cz);
      if (k < 0) continue;
      raw.push({ poly: [outer], rect, aM, k, t: {}, id: 2e9 + n, src: 1, box, tagH: false, msH });
      added++;
    }
  }
  console.log(`Microsoft footprints: ${n} in range · ${added} added where OpenStreetMap had none · ${heights} OpenStreetMap buildings got a height`);
}

const roadGrid = new Grid(0.03);
const sq = new Uint16Array(readFileSync(`${PUB}streets.bin`).buffer.slice(0));
for (let i = 0; i < sq.length; i += 4) {
  const ax = (sq[i] / 65535) * BIG.streets.qx, az = (sq[i + 1] / 65535) * BIG.streets.qz, bx = (sq[i + 2] / 65535) * BIG.streets.qx, bz = (sq[i + 3] / 65535) * BIG.streets.qz;
  const seg = [ax, az, bx, bz, 0.0075];
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.02) + 1;
  for (let s = 0; s <= n; s++) roadGrid.add(ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n, 0.0001, seg);
}
for (const [lines, wdt] of [[BIG.highways, 0.016], [BIG.interstates, 0.03]]) for (const l of lines) for (let i = 0; i < l.length - 1; i++) {
  const [ax, az] = l[i], [bx, bz] = l[i + 1];
  const seg = [ax, az, bx, bz, wdt];
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.02) + 1;
  for (let s = 0; s <= n; s++) roadGrid.add(ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n, wdt, seg);
}
const segDist = (x, z, [ax, az, bx, bz]) => {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-12;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
};
/** Which side of a box faces the nearest street: 0 +z, 1 −z, 2 +x, 3 −x (in its own frame). */
function frontOf(rect) {
  const ca = Math.cos(rect.ang), sa = Math.sin(rect.ang);
  const sides = [[-sa, ca, rect.d], [sa, -ca, rect.d], [ca, sa, rect.w], [-ca, -sa, rect.w]];
  let best = 0, bd = Infinity;
  sides.forEach(([nx, nz, ext], i) => {
    const off = ext / 2 + 8 / M;
    const px = rect.cx + nx * off, pz = rect.cz + nz * off;
    for (const sg of roadGrid.near(px, pz)) {
      const d = segDist(px, pz, sg) - (i >= 2 ? 3 / M : 0); // a tie goes to a long side
      if (d < bd) { bd = d; best = i; }
    }
  });
  return best;
}

// pass 3: classify and pack
for (const b of raw) {
  const { poly, rect, aM, k, t, id } = b;
  const outer = poly[0];
  const { cx, cz } = rect;
  const r = hash(id);
  const lev = num(t['building:levels']);
  let hM = num(t.height);
  const topH = hM > 0 ? hM : b.msH > 0 ? b.msH : 0; // measured to the top of the roof
  let kind = TYPE[t.building];
  const camp = campusAt(cx, cz);
  if (kind == null) {
    if (camp && aM > 250) kind = UNI;
    else if (aM < 330 && !(topH > 14)) kind = HOUSE;
    else if (aM < 1500) kind = r < 0.5 ? COM : APT;
    else kind = aM > 6000 ? IND : COM;
  }
  if (t.building === 'residential') kind = aM < 350 ? HOUSE : APT;
  if (camp && (kind === COM || kind === CIVIC || kind === APT) && aM > 250) kind = UNI;
  if (kind === HOUSE && aM > 900) kind = APT;
  if ((topH >= 40 || lev >= 12) && kind !== CIVIC) kind = TOWER;
  let roof = ROOF_TAG[t['roof:shape']];
  if (roof == null) {
    roof = FLAT;
    if (kind === HOUSE) roof = rect.d * M > 26 ? FLAT : r < 0.58 ? HIP : GABLE;
    else if (kind === SMALL) roof = r < 0.5 && aM < 100 && t.building !== 'roof' ? GABLE : FLAT; // canopies are flat
    else if (kind === APT && rect.d * M <= 24 && !(topH > 16)) roof = r < 0.55 ? HIP : GABLE; // narrow garden apartments
    else if (kind === UNI && rect.d * M <= 30 && !(topH > 24)) roof = r < (camp?.smu ? 0.75 : 0.35) ? (r < 0.4 ? HIP : GABLE) : FLAT;
    else if (kind === CIVIC && /church|chapel|cathedral/.test(t.building)) roof = GABLE;
  }
  if (roof !== FLAT && rect.d * M > 28) roof = FLAT; // nothing that wide carries one pitched roof
  const pitchM = roof === FLAT ? 0 : Math.min(rect.d * M * 0.24, 5);
  // wall heights: real where measured (less the roof), else from levels, else typical for Dallas
  if (topH > 0) hM = Math.max(kind === HOUSE ? 2.7 : 3, topH - pitchM);
  else if (lev > 0) hM = lev * (kind === COM || kind === TOWER ? 3.8 : 3.2) + (kind === HOUSE ? 0.4 : 0.5);
  else hM = {
    [HOUSE]: aM < 110 ? 3.0 : r < (aM > 230 ? 0.4 : 0.15) ? 5.8 : 3.0,
    [APT]: aM > 1800 ? 10.5 : 7.5,
    [COM]: aM > 3000 ? 8 : 5.5 + r * 2,
    [IND]: 7 + r * 4,
    [CIVIC]: t.building === 'church' ? 11 : t.building === 'hospital' ? 24 : 8,
    [UNI]: 10 + r * 6,
    [TOWER]: 60,
    [SMALL]: 3,
  }[kind] ?? 6;
  hM = Math.min(hM, 330);
  if (hM >= 40 && kind !== CIVIC) kind = TOWER;
  const variant = camp?.smu && kind === UNI ? Math.floor(r * 4) : Math.floor(hash(id * 7 + 3) * 16);
  const style = kind | (roof << 3) | (variant << 5);
  const big = aM >= 2500 || hM >= 16;
  if (t.name && (aM > 1500 || hM > 60 || /Dallas Hall/.test(t.name))) named.push({ name: t.name, x: cx, z: cz, h: hM + pitchM, a: aM });
  // irregular large buildings keep their real outline; everything else is its rectangle
  const fill = aM / (rect.area * M * M);
  if (aM >= 450 && (fill < 0.86 || poly.length > 1) && outer.length >= 5) {
    const tol = 0.7 / M;
    const rings = poly.map((ring) => {
      const open = ring.slice(0, -1);
      const s2 = dp(open.concat([open[0]]), tol).slice(0, -1);
      return s2.length >= 3 ? s2 : open;
    }).filter((ring) => ring.length >= 3 && ring.length < 2000);
    if (rings.length) { polys.push({ rings, x: cx, z: cz, hM, style, k, big, aM }); continue; }
  }
  const facing = kind === HOUSE || kind === COM || kind === IND || kind === APT ? frontOf(rect) : 0;
  rects.push({ x: cx, z: cz, a: rect.ang, w: rect.w * M, d: rect.d * M, hM, style: style | (facing << 9), k, big, aM, kind });
}
raw.length = 0;
{
  const cells = new Map();
  for (const [r, x, z] of whyAt) { const k = `${r} ${Math.floor(x)},${Math.floor(z)}`; cells.set(k, (cells.get(k) ?? 0) + 1); }
  console.log('skipped inside the county:', JSON.stringify(why), [...cells].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}: ${n}`).join(' · '));
}
console.log(`${files.length} tiles · ${rects.length} boxes · ${polys.length} outlines · ${skipped} outside the county or cleared`);
const kinds = new Array(8).fill(0);
for (const b of rects) kinds[b.style & 7]++;
for (const b of polys) kinds[b.style & 7]++;
console.log('by kind: house apt com ind civic uni tower small =', kinds.join(' '));

// ---------- chunks: big buildings always drawn (8×8-unit cells), small ones up close (4×4, culled finer) ----------
const CELL = 8, NX = Math.ceil(W / CELL), SCELL = 4, SNX = Math.ceil(W / SCELL);
const cellOf = (b) => b.big
  ? Math.min(NX - 1, Math.floor(b.z / CELL)) * NX + Math.min(NX - 1, Math.floor(b.x / CELL))
  : 10000 + Math.min(SNX - 1, Math.floor(b.z / SCELL)) * SNX + Math.min(SNX - 1, Math.floor(b.x / SCELL));
const order = (a, b) => (a.big === b.big ? cellOf(a) - cellOf(b) : a.big ? -1 : 1);
rects.sort(order);
polys.sort(order);
const chunksOf = (list, sizeOf) => {
  const out = [];
  let off = 0;
  for (let i = 0; i < list.length;) {
    const b0 = list[i], c = cellOf(b0);
    let j = i, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, hMax = 0, len = 0;
    while (j < list.length && list[j].big === b0.big && cellOf(list[j]) === c) {
      const b = list[j], r = Math.max(b.w ?? 0, Math.sqrt(b.aM) * 1.5) / M;
      x0 = Math.min(x0, b.x - r); z0 = Math.min(z0, b.z - r); x1 = Math.max(x1, b.x + r); z1 = Math.max(z1, b.z + r);
      hMax = Math.max(hMax, b.hM); len += sizeOf(b); j++;
    }
    out.push({ big: b0.big ? 1 : 0, start: i, count: j - i, off, len, box: [x0, z0, x1, z1].map((v) => Math.round(v * 1000) / 1000), hMax: Math.round(hMax) });
    off += len;
    i = j;
  }
  return out;
};
const q = (v, max) => Math.max(0, Math.min(65535, Math.round((v / max) * 65535)));
const dm = (m) => Math.max(1, Math.min(65535, Math.round(m * 10)));
// RECT: x, z, angle (0..π), long side dm, short side dm, wall height dm, style (kind | roof << 3 | variant << 5), circuit
const rectBin = new Uint16Array(rects.length * 8);
rects.forEach((b, i) => rectBin.set([q(b.x, W), q(b.z, H), q(b.a, Math.PI), dm(b.w), dm(b.d), dm(b.hM), b.style, b.k], i * 8));
// POLY: ring count, wall height dm, style, circuit, then per ring: vertex count, x0, z0, x1, z1, ...
const polyWords = (b) => 4 + b.rings.reduce((s, r) => s + 1 + r.length * 2, 0);
const polyLen = polys.reduce((s, b) => s + polyWords(b), 0);
const polyBin = new Uint16Array(polyLen);
{
  let o = 0;
  for (const b of polys) {
    polyBin.set([b.rings.length, dm(b.hM), b.style, b.k], o); o += 4;
    for (const r of b.rings) { polyBin[o++] = r.length; for (const [x, z] of r) { polyBin[o++] = q(x, W); polyBin[o++] = q(z, H); } }
  }
}
writeFileSync(`${PUB}rects.bin`, Buffer.from(rectBin.buffer));
writeFileSync(`${PUB}polys.bin`, Buffer.from(polyBin.buffer));

// ---------- trees: yards, woods, creeks and parks ----------
const occ = new Grid(0.02);
for (const b of rects) occ.add(b.x, b.z, Math.max(b.w, b.d) / M / 2, [b.x, b.z, Math.max(b.w, b.d) / M / 2 + 0.002]);
for (const b of polys) for (const r of b.rings) { const bb = bboxOf(r); const rr = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 2; occ.add((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, rr, [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, rr]); }
const free = (x, z, r) => {
  for (const [bx, bz, br] of occ.near(x, z)) if (Math.hypot(x - bx, z - bz) < br + r * 0.6) return false;
  for (const s of roadGrid.near(x, z)) if (segDist(x, z, s) < s[4] + r * 0.5) return false;
  return true;
};
const trees = [];
let budget = 0; // each source gets its own share
// the county as a 1024² mask, so trees can be clipped to it cheaply
const MASK = 1024, mask = new Uint8Array(MASK * MASK);
for (let j = 0; j < MASK; j++) for (let i = 0; i < MASK; i++) mask[j * MASK + i] = inCounty(((i + 0.5) / MASK) * W, ((j + 0.5) / MASK) * H) ? 1 : 0;
const inMask = (x, z) => mask[Math.min(MASK - 1, Math.floor((z / H) * MASK)) * MASK + Math.min(MASK - 1, Math.floor((x / W) * MASK))] === 1;
const addTree = (x, z, r) => {
  if (trees.length >= budget || x < 0 || z < 0 || x > W || z > H || !inMask(x, z)) return false;
  if (!free(x, z, r) || inLake(x, z)) return false;
  trees.push([x, z, r]);
  occ.add(x, z, r * 0.5, [x, z, r * 0.45]);
  return true;
};
const noise = (x, z) => { // cheap value noise for canopy clumps
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const h = (i, j) => hash(i * 73856093 ^ j * 19349663);
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  return (h(xi, zi) * (1 - sx) + h(xi + 1, zi) * sx) * (1 - sz) + (h(xi, zi + 1) * (1 - sx) + h(xi + 1, zi + 1) * sx) * sz;
};
const crown = () => (4.5 + rnd() * 5.5) / M; // crown radius, m → units
// yards: a few trees around most houses, more where the canopy is thick (older neighborhoods)
const houses = rects.filter((b) => (b.style & 7) === HOUSE);
const yardShare = Math.min(1, 330000 / (houses.length * 1.2 + 1));
budget = 330000;
for (const b of houses) {
  if (rnd() > yardShare) continue;
  if ((b.style & 7) !== HOUSE) continue;
  const canopy = noise(b.x * 3, b.z * 3) * 0.7 + noise(b.x * 11, b.z * 11) * 0.3;
  const n = Math.floor(canopy * 3.6 + rnd() * 0.9);
  for (let j = 0; j < n; j++) {
    const a = rnd() * Math.PI * 2, dist = (Math.max(b.w, b.d) / 2 + 4 + rnd() * 14) / M;
    addTree(b.x + Math.cos(a) * dist, b.z + Math.sin(a) * dist, crown());
  }
}
console.log(`${trees.length} yard trees`);
// woods (the Great Trinity Forest and creek bottoms), mapped in OpenStreetMap
budget = trees.length + 110000;
const woodArea = woods.reduce((s, wd) => s + (wd.box[2] - wd.box[0]) * (wd.box[3] - wd.box[1]), 0) * M * M;
const perTree = Math.max(420, woodArea / 160000);
for (const wd of woods) {
  const [x0, z0, x1, z1] = wd.box;
  const n = Math.ceil(((x1 - x0) * (z1 - z0) * M * M) / perTree);
  for (let j = 0; j < n; j++) {
    const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
    if (wd.polys.some((p) => inPoly(x, z, p)) && inCounty(x, z)) addTree(x, z, crown() * 1.1);
  }
}
console.log(`${trees.length} with woods`);
// creeks and the river
budget = trees.length + 40000;
const walk = (lines, step, fn) => {
  for (const l of lines) for (let i = 0; i < l.length - 1; i++) {
    const [ax, az] = l[i], [bx, bz] = l[i + 1], len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-9) continue;
    for (let s = 0; s < len; s += step) fn(ax + ((bx - ax) * s) / len, az + ((bz - az) * s) / len, -(bz - az) / len, (bx - ax) / len);
  }
};
const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
walk(BIG.creeks, 0.012, (x, z, nx, nz) => { for (let j = 0; j < 2; j++) { const o = gauss() * 0.03; addTree(x + nx * o, z + nz * o, crown()); } });
walk(BIG.rivers, 0.012, (x, z, nx, nz) => { for (let j = 0; j < 3; j++) { const o = gauss() * 0.12; addTree(x + nx * o, z + nz * o, crown() * 1.1); } });
// parks and golf courses: scattered groves
budget = trees.length + 25000;
for (const lu of BIG.landuse) {
  if (lu.k !== 'park' && lu.k !== 'golf' && lu.k !== 'cemetery' && lu.k !== 'campus') continue;
  for (const poly of lu.polys) {
    const [x0, z0, x1, z1] = bboxOf(poly[0]);
    const n = Math.min(8000, Math.ceil(((x1 - x0) * (z1 - z0) * M * M) / (lu.k === 'park' ? 900 : 2200)));
    for (let j = 0; j < n; j++) {
      const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
      if (noise(x * 20, z * 20) < (lu.k === 'park' ? 0.45 : 0.55)) continue;
      if (inPoly(x, z, poly)) addTree(x, z, crown());
    }
  }
}
console.log(`${trees.length} trees`);
// trees by cell, so the game can skip the ones off screen
const tCell = ([x, z]) => Math.min(SNX - 1, Math.floor(z / SCELL)) * SNX + Math.min(SNX - 1, Math.floor(x / SCELL));
trees.sort((a, b) => tCell(a) - tCell(b));
const treeChunks = [];
for (let i = 0; i < trees.length;) {
  const c = tCell(trees[i]);
  let j = i, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  while (j < trees.length && tCell(trees[j]) === c) { const [x, z] = trees[j]; x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); j++; }
  treeChunks.push({ start: i, count: j - i, box: [x0 - 0.02, z0 - 0.02, x1 + 0.02, z1 + 0.02].map((v) => Math.round(v * 1000) / 1000) });
  i = j;
}
const treeBin = new Uint16Array(trees.length * 3);
trees.forEach(([x, z, r], i) => treeBin.set([q(x, W), q(z, H), Math.round(r * M * 100)], i * 3));
writeFileSync(`${PUB}trees.bin`, Buffer.from(treeBin.buffer));

// ---------- index, campuses, landmarks ----------
const labelCampus = campuses
  .filter((c) => c.a > 60000 && c.name)
  .map((c) => {
    let sx = 0, sz = 0, n = 0;
    for (const [x, z] of c.polys[0][0]) { sx += x; sz += z; n++; }
    let x = sx / n, z = sz / n;
    if (!inCounty(x, z)) { // campuses across the county line (UT Dallas): label the part inside
      let ix = 0, iz = 0, k = 0;
      for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
        const px = c.box[0] + ((c.box[2] - c.box[0]) * i) / 20, pz = c.box[1] + ((c.box[3] - c.box[1]) * j) / 20;
        if (inCounty(px, pz) && c.polys.some((p) => inPoly(px, pz, p))) { ix += px; iz += pz; k++; }
      }
      if (k) { x = ix / k; z = iz / k + 0.12; }
    }
    return { name: c.name.replace(/^The /, ''), x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, a: Math.round(c.a) };
  })
  .filter((c) => inCounty(c.x, c.z))
  .sort((a, b) => b.a - a.a);
const dedup = [];
for (const c of labelCampus) if (!dedup.some((d) => d.name === c.name || Math.hypot(d.x - c.x, d.z - c.z) < 0.6)) dedup.push(c);
const index = {
  metersPerUnit: M,
  cell: CELL,
  rects: { count: rects.length, chunks: chunksOf(rects, () => 8) },
  polys: { count: polys.length, words: polyLen, chunks: chunksOf(polys, polyWords) },
  trees: { count: trees.length, chunks: treeChunks },
  campuses: dedup,
  named: named.sort((a, b) => b.h - a.h).slice(0, 80).map((n) => ({ ...n, x: Math.round(n.x * 1000) / 1000, z: Math.round(n.z * 1000) / 1000, h: Math.round(n.h), a: Math.round(n.a) })),
};
writeFileSync(`${PUB}buildings.json`, JSON.stringify(index));
// map labels for campuses and landmarks go into the small bundled file (prep-dallas.mjs runs first)
const SHORT = {
  'Southern Methodist University': 'SMU', 'University of Texas at Dallas': 'UT Dallas', 'University of Texas Southwestern Medical Center': 'UT Southwestern',
  'University of North Texas - Dallas': 'UNT Dallas', 'Dallas College Richland Campus': 'Richland College', 'Brookhaven Community College': 'Brookhaven College',
};
const KEEP = /SMU|UT Dallas|UT Southwestern|UNT Dallas|Paul Quinn|Dallas Baptist|University of Dallas|Richland|El Centro|Eastfield|Cedar Valley|Mountain View|Brookhaven|North Lake/;
const LANDMARKS = [
  ['Reunion Tower', 32.7755, -96.8089], ['Bank of America Plaza', 32.7790, -96.8046], ['American Airlines Center', 32.7905, -96.8103],
  ['Klyde Warren Park', 32.7893, -96.8016], ['Dealey Plaza', 32.7788, -96.8086], ['Cotton Bowl', 32.7795, -96.7593], ['Dallas Zoo', 32.7409, -96.8158],
  ['NorthPark Center', 32.8686, -96.7738], ['Galleria Dallas', 32.9305, -96.8199], ['Dallas Arboretum', 32.8231, -96.7166],
  ['Margaret Hunt Hill Bridge', 32.7835, -96.8192], ['Dallas Hall', 32.8452, -96.7847], ['Gerald J. Ford Stadium', 32.8375, -96.7828],
];
GEN.campuses = dedup.map((c) => ({ ...c, name: SHORT[c.name] ?? c.name })).filter((c) => KEEP.test(c.name)).map(({ name, x, z }) => ({ name, x, z }));
// labels sit on the real building when OpenStreetMap has it by that name
GEN.landmarks = LANDMARKS.map(([name, lat, lon]) => {
  let [x, z] = LL(lat, lon);
  const hit = named.find((n) => n.name === name && Math.hypot(n.x - x, n.z - z) < 0.5);
  if (hit) [x, z] = [hit.x, hit.z];
  return { name, x: Math.round(x * 1000) / 1000, z: Math.round(z * 1000) / 1000 };
});
writeFileSync(new URL('../src/map/dallas.gen.json', import.meta.url), JSON.stringify(GEN));
console.log('labels:', GEN.campuses.map((c) => c.name).join(' · '));
console.log(`rects.bin ${(rectBin.byteLength / 1e6).toFixed(1)} MB · polys.bin ${(polyBin.byteLength / 1e6).toFixed(1)} MB · trees.bin ${(treeBin.byteLength / 1e6).toFixed(1)} MB · ${index.rects.chunks.length}+${index.polys.chunks.length} chunks`);
console.log('campuses:', dedup.slice(0, 20).map((c) => c.name).join(' · '));
console.log('tallest:', index.named.slice(0, 12).map((n) => `${n.name} ${n.h}m`).join(' · '));
