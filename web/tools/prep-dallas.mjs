// Builds the real Dallas County map for the game from public-domain Census TIGER files and CDC SVI.
// Run once: node tools/prep-dallas.mjs   (inputs in ../data/geo, see README)
// Outputs:
//   src/map/dallas.gen.json   small: circuits, buildings, landmarks, streetlights, labels (bundled)
//   public/geo/dallas.json    large: county, tract plates, outlines, water, major roads, land use (fetched)
//   public/geo/streets.bin    local streets as quantized segments (fetched)
// Buildings and trees come from the real OpenStreetMap outlines: run tools/prep-buildings.mjs after this.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as shapefile from 'shapefile';

const GEO = new URL('../../data/geo/', import.meta.url).pathname;
const OUT_SRC = new URL('../src/map/dallas.gen.json', import.meta.url).pathname;
const OUT_PUB = new URL('../public/geo/', import.meta.url).pathname;
mkdirSync(OUT_PUB, { recursive: true });

const MI_PER_UNIT = 0.6;

// ---------- helpers ----------
let seed = 20210215;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const r2 = (v) => Math.round(v * 100) / 100;

async function readShp(name, filter = () => true) {
  const src = await shapefile.open(`${GEO}${name}.shp`, `${GEO}${name}.dbf`);
  const out = [];
  for (let r = await src.read(); !r.done; r = await src.read()) if (filter(r.value.properties)) out.push(r.value);
  return out;
}

function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const row = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else cur += ch;
    }
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function dp(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Simplify a closed ring (or closed chain): split at the point farthest from the start, simplify both halves. */
function dpRing(ring, tol) {
  const closed = ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  if (!closed) return dp(ring, tol);
  const open = ring.slice(0, -1);
  let far = 1, fd = -1;
  for (let i = 1; i < open.length; i++) {
    const d = Math.hypot(open[i][0] - open[0][0], open[i][1] - open[0][1]);
    if (d > fd) { fd = d; far = i; }
  }
  const a = dp(open.slice(0, far + 1), tol);
  const b = dp([...open.slice(far), open[0]], tol);
  return [...a, ...b.slice(1)];
}

const ringsOf = (geom) => (geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : []);
const linesOf = (geom) => (geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : []);

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pointInPoly = (x, y, poly) => pointInRing(x, y, poly[0]) && !poly.slice(1).some((h) => pointInRing(x, y, h));

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// ---------- county and projection ----------
const [county] = await readShp('county/cb_2023_us_county_500k', (p) => p.GEOID === '48113');
const cRings = ringsOf(county.geometry);
let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
for (const poly of cRings) for (const [lon, lat] of poly[0]) {
  lonMin = Math.min(lonMin, lon); lonMax = Math.max(lonMax, lon); latMin = Math.min(latMin, lat); latMax = Math.max(latMax, lat);
}
const lat0 = (latMin + latMax) / 2;
const KX = (Math.cos((lat0 * Math.PI) / 180) * 69.17) / MI_PER_UNIT;
const KZ = 69.0 / MI_PER_UNIT;
const P = ([lon, lat]) => [(lon - lonMin) * KX, (latMax - lat) * KZ];
const W = (lonMax - lonMin) * KX, H = (latMax - latMin) * KZ;
const countyPolys = cRings.map((poly) => poly.map((ring) => dpRing(ring.map(P), 0.03)));
console.log(`county ${W.toFixed(1)} × ${H.toFixed(1)} units (${(W * MI_PER_UNIT).toFixed(1)} × ${(H * MI_PER_UNIT).toFixed(1)} mi)`);

// ---------- tracts with population and vulnerability ----------
const svi = parseCSV(readFileSync(`${GEO}svi_tx.csv`, 'utf8').replace(/^﻿/, ''));
const hdr = svi[0];
const iF = hdr.indexOf('FIPS'), iPop = hdr.indexOf('E_TOTPOP'), iRpl = hdr.indexOf('RPL_THEMES');
const sviBy = new Map(svi.slice(1).map((r) => [r[iF], { pop: Number(r[iPop]) || 0, rpl: Number(r[iRpl]) }]));
const tractsRaw = await readShp('tracts/tl_2024_48_tract', (p) => p.COUNTYFP === '113');
const tracts = tractsRaw.map((f) => {
  const polys = ringsOf(f.geometry).map((poly) => poly.map((ring) => ring.map(P)));
  const s = sviBy.get(f.properties.GEOID) ?? { pop: 0, rpl: NaN };
  let cx = 0, cy = 0, n = 0;
  for (const [x, y] of polys[0][0]) { cx += x; cy += y; n++; }
  return { id: f.properties.GEOID, polys, pop: s.pop, rpl: s.rpl >= 0 ? s.rpl : null, c: [cx / n, cy / n], aland: Number(f.properties.ALAND) };
});
const totalPop = tracts.reduce((s, t) => s + t.pop, 0);
console.log(`${tracts.length} tracts, ${totalPop.toLocaleString()} people`);

// ---------- circuits: tracts grouped around real neighborhoods, balanced to the spec's populations ----------
const CIRCUITS = [
  ['C-01', 100000, 32.7810, -96.7980], ['C-02', 120000, 32.8120, -96.8420], ['C-03', 160000, 32.6600, -96.9000],
  ['C-04', 160000, 32.8050, -96.7200], ['C-05', 140000, 32.7850, -96.9000], ['C-06', 180000, 32.7300, -96.7600],
  ['C-07', 200000, 32.7550, -96.8350], ['C-08', 200000, 32.7300, -96.8700], ['C-09', 200000, 32.7000, -96.8250],
  ['C-10', 180000, 32.8850, -96.7150], ['C-11', 180000, 32.8650, -96.6650], ['C-12', 180000, 32.9150, -96.7700],
  ['C-13', 200000, 32.7100, -96.6950], ['C-14', 200000, 32.6700, -96.7350], ['C-15', 200000, 32.7400, -96.6300],
].map(([id, people, lat, lon]) => ({ id, people, seed: P([lon, lat]) }));
const scale = totalPop / CIRCUITS.reduce((s, c) => s + c.people, 0);
const target = (k) => CIRCUITS[k].people * scale;

// landmarks and critical buildings at real places; their tracts start in the right circuit
const LL = (lat, lon) => P([lon, lat]);
const BUILDINGS = {
  'hospital-1': { at: LL(32.8106, -96.8382), circuit: 'C-02' }, // Parkland, Medical District
  'dialysis-1': { at: LL(32.6650, -96.8950), circuit: 'C-03' },
  'water-1': { at: LL(32.8160, -96.7085), circuit: 'C-04' }, // by White Rock Lake
  'gas-1': { at: LL(32.7760, -96.8950), circuit: 'C-05' },
  'school-1': { at: LL(32.7450, -96.7650), circuit: 'C-06' }, // near Fair Park
};
const tractAt = (x, y) => tracts.findIndex((t) => t.polys.some((poly) => pointInPoly(x, y, poly)));
const cIndex = Object.fromEntries(CIRCUITS.map((c, k) => [c.id, k]));

// tracts that share a boundary vertex are neighbors
const vkey = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
const adj = tracts.map(() => new Set());
const byVertex = new Map();
tracts.forEach((t, i) => {
  for (const poly of t.polys) for (const ring of poly) for (const p of ring) {
    const kk = vkey(p);
    let set = byVertex.get(kk);
    if (!set) byVertex.set(kk, (set = new Set()));
    for (const j of set) if (j !== i) { adj[i].add(j); adj[j].add(i); }
    set.add(i);
  }
});

// Circuits grow outward from their real neighborhoods, one adjacent tract at a time, least-filled first,
// so each circuit is one connected piece around its own neighborhood (Downtown stays downtown).
const assign = new Array(tracts.length).fill(-1);
const pops = CIRCUITS.map(() => 0);
const frontier = CIRCUITS.map(() => new Set());
const pinned = new Set();
const claim = (i, k) => {
  if (assign[i] >= 0) pops[assign[i]] -= tracts[i].pop;
  assign[i] = k;
  pops[k] += tracts[i].pop;
  for (const j of adj[i]) if (assign[j] < 0) frontier[k].add(j);
};
CIRCUITS.forEach((c, k) => { const ti = tractAt(...c.seed); if (ti >= 0 && assign[ti] < 0) { claim(ti, k); pinned.add(ti); } });
for (const b of Object.values(BUILDINGS)) { const ti = tractAt(...b.at); if (ti >= 0) { claim(ti, cIndex[b.circuit]); pinned.add(ti); } }
const d2 = (i, k) => (tracts[i].c[0] - CIRCUITS[k].seed[0]) ** 2 + (tracts[i].c[1] - CIRCUITS[k].seed[1]) ** 2;
for (;;) { // nearest tract wins, with circuits that are filling up paying more for distance
  let bk = -1, bi = -1, bc = Infinity;
  CIRCUITS.forEach((c, k) => {
    const f = pops[k] / target(k);
    for (const j of frontier[k]) {
      if (assign[j] >= 0) { frontier[k].delete(j); continue; }
      const cost = (d2(j, k) + 1) * (0.5 + f) ** 3;
      if (cost < bc) { bc = cost; bk = k; bi = j; }
    }
  });
  if (bk < 0) break;
  claim(bi, bk);
}
tracts.forEach((_, i) => { // islands with no shared vertex: nearest seed
  if (assign[i] >= 0) return;
  let bk = 0, bd = Infinity;
  CIRCUITS.forEach((_, k) => { const d = d2(i, k); if (d < bd) { bd = d; bk = k; } });
  claim(i, bk);
});

// even out populations: hand boundary tracts from fuller circuits to emptier neighbors, keeping both connected
const connectedWithout = (k, drop) => {
  const mine = [];
  assign.forEach((a, i) => { if (a === k && i !== drop) mine.push(i); });
  if (!mine.length) return false;
  const seen = new Set([mine[0]]), stack = [mine[0]];
  while (stack.length) { const i = stack.pop(); for (const j of adj[i]) if (j !== drop && assign[j] === k && !seen.has(j)) { seen.add(j); stack.push(j); } }
  return seen.size === mine.length;
};
const err = (k) => pops[k] / target(k) - 1;
const COMPACT = Number(process.env.COMPACT ?? 0.015), NORM = (totalPop / CIRCUITS.length) * 25;
const tried = new Set();
for (let it = 0; it < 30000; it++) {
  let best = null, bestGain = 1e-6;
  assign.forEach((from, i) => {
    if (pinned.has(i)) return;
    for (const j of adj[i]) {
      const to = assign[j];
      if (to === from || tried.has(`${i}>${to}`)) continue;
      const p = tracts[i].pop;
      const ef = (pops[from] - p) / target(from) - 1, et = (pops[to] + p) / target(to) - 1;
      // balance, traded against compactness: people far from their circuit's own neighborhood cost extra
      const gain = err(from) ** 2 + err(to) ** 2 - ef * ef - et * et + COMPACT * p * (d2(i, from) - d2(i, to)) / NORM;
      if (gain > bestGain) { bestGain = gain; best = [i, to, from]; }
    }
  });
  if (!best) break;
  if (connectedWithout(best[2], best[0])) { claim(best[0], best[1]); tried.clear(); }
  else tried.add(`${best[0]}>${best[1]}`);
}
const bestErr = Math.max(...CIRCUITS.map((_, k) => Math.abs(err(k))));
const spread = Math.max(...tracts.map((t, i) => Math.sqrt(d2(i, assign[i])))) * MI_PER_UNIT;
console.log(`circuit balance: worst ${(bestErr * 100).toFixed(1)}% off the spec population share; farthest tract ${spread.toFixed(1)} mi from its neighborhood`);
if (process.env.REACH) console.log('reach (mi):', CIRCUITS.map((c, k) => `${c.id} ${(Math.sqrt(Math.max(0, ...tracts.map((t, i) => (assign[i] === k ? d2(i, k) : 0)))) * MI_PER_UNIT).toFixed(0)}`).join(' '));
const circuitOfPoint = (x, y) => { const ti = tractAt(x, y); return ti >= 0 ? assign[ti] : -1; };

// ---------- outlines: tract edges that are not shared within the same circuit ----------
const key = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
const outlines = {};
const plates = {};
CIRCUITS.forEach((c, k) => {
  const edges = new Map();
  const mine = tracts.filter((_, i) => assign[i] === k);
  for (const t of mine) for (const poly of t.polys) for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1], ka = key(a), kb = key(b);
      if (ka === kb) continue;
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = edges.get(ek);
      if (e) e.n++; else edges.set(ek, { a, b, ka, kb, n: 1 });
    }
  }
  const boundary = [...edges.values()].filter((e) => e.n === 1);
  const adj = new Map();
  for (const e of boundary) {
    (adj.get(e.ka) ?? adj.set(e.ka, []).get(e.ka)).push(e);
    (adj.get(e.kb) ?? adj.set(e.kb, []).get(e.kb)).push(e);
  }
  const used = new Set();
  const chains = [];
  for (const e of boundary) {
    if (used.has(e)) continue;
    used.add(e);
    const chain = [e.a, e.b];
    let endKey = e.kb;
    for (;;) {
      const next = (adj.get(endKey) ?? []).find((x) => !used.has(x));
      if (!next) break;
      used.add(next);
      const forward = next.ka === endKey;
      chain.push(forward ? next.b : next.a);
      endKey = forward ? next.kb : next.ka;
    }
    const simple = dpRing(chain, 0.04);
    if (simple.length >= 2) chains.push(simple.map(([x, y]) => [r2(x), r2(y)]));
  }
  outlines[c.id] = chains;
  plates[c.id] = mine.flatMap((t) => t.polys.map((poly) => poly.map((ring) => dpRing(ring, 0.04).map(([x, y]) => [r2(x), r2(y)]))));
});

// ---------- water ----------
const area = await readShp('areawater/tl_2024_48113_areawater', (p) => Number(p.AWATER) > 120000);
const lakes = area.flatMap((f) => ringsOf(f.geometry).map((poly) => poly.map((ring) => dpRing(ring.map(P), 0.03).map(([x, y]) => [r2(x), r2(y)]))))
  .filter((poly) => poly[0].length >= 4);
const linear = await readShp('linearwater/tl_2024_48113_linearwater', (p) => /Trinity|Crk|Creek/i.test(p.FULLNAME ?? ''));
const rivers = [], creeks = [];
for (const f of linear) for (const line of linesOf(f.geometry)) {
  const pts = dp(line.map(P), 0.03).map(([x, y]) => [r2(x), r2(y)]);
  if (pts.length >= 2) (/Trinity/i.test(f.properties.FULLNAME) ? rivers : creeks).push(pts);
}
const inLake = (x, y) => lakes.some((poly) => pointInPoly(x, y, poly));

// ---------- roads ----------
const roads = await readShp('roads/tl_2024_48113_roads', (p) => ['S1100', 'S1200', 'S1400', 'S1630', 'S1640'].includes(p.MTFCC));
const interstates = [], highways = [], streetSegs = [];
const majorSegs = [], localSegs = [];
for (const f of roads) for (const line of linesOf(f.geometry)) {
  const m = f.properties.MTFCC;
  const pts = dp(line.map(P), m === 'S1400' ? 0.035 : 0.02);
  if (pts.length < 2) continue;
  if (m === 'S1100' || m === 'S1200') {
    (m === 'S1100' ? interstates : highways).push(pts.map(([x, y]) => [r2(x), r2(y)]));
    for (let i = 0; i < pts.length - 1; i++) majorSegs.push([...pts[i], ...pts[i + 1]]);
  } else for (let i = 0; i < pts.length - 1; i++) {
    streetSegs.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (m === 'S1400') localSegs.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
  }
}
const q = new Uint16Array(streetSegs.length + 2);
const QX = 65535 / W, QZ = 65535 / H;
for (let i = 0; i < streetSegs.length; i += 2) {
  q[i] = Math.max(0, Math.min(65535, Math.round(streetSegs[i] * QX)));
  q[i + 1] = Math.max(0, Math.min(65535, Math.round(streetSegs[i + 1] * QZ)));
}
writeFileSync(`${OUT_PUB}streets.bin`, Buffer.from(q.buffer, 0, streetSegs.length * 2));
console.log(`roads: ${interstates.length} interstate lines, ${highways.length} highway lines, ${streetSegs.length / 4} street segments`);

// spatial grid for "near a major road"
const GRID = 2, grid = new Map();
majorSegs.forEach((s, i) => {
  const x0 = Math.floor(Math.min(s[0], s[2]) / GRID), x1 = Math.floor(Math.max(s[0], s[2]) / GRID);
  const y0 = Math.floor(Math.min(s[1], s[3]) / GRID), y1 = Math.floor(Math.max(s[1], s[3]) / GRID);
  for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) (grid.get(`${gx},${gy}`) ?? grid.set(`${gx},${gy}`, []).get(`${gx},${gy}`)).push(i);
});
const nearMajor = (x, y, d) => {
  const gx = Math.floor(x / GRID), gy = Math.floor(y / GRID);
  for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++)
    for (const si of grid.get(`${i},${j}`) ?? []) { const s = majorSegs[si]; if (segDist(x, y, s[0], s[1], s[2], s[3]) < d) return true; }
  return false;
};

// ---------- downtown, landmarks ----------
const downtown = LL(32.7810, -96.7985);
const TOWERS = []; // filled below, on the real downtown blocks
const reunion = LL(32.7755, -96.8089);
const plant = LL(32.7279, -96.9405); // Mountain Creek gas plant
const waterTower = LL(32.8600, -96.7700);
const hub = LL(32.7700, -96.8150); // central substation by the Trinity

// ---------- spatial helpers and noise ----------
function pointHash(cell) {
  const m = new Map();
  const key = (gx, gy) => gx * 100003 + gy;
  return {
    add(x, y, r) { const k = key(Math.floor(x / cell), Math.floor(y / cell)); (m.get(k) ?? m.set(k, []).get(k)).push(x, y, r); },
    free(x, y, r) {
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++) {
        const a = m.get(key(i, j));
        if (!a) continue;
        for (let q = 0; q < a.length; q += 3) { const d = r + a[q + 2]; if ((a[q] - x) ** 2 + (a[q + 1] - y) ** 2 < d * d) return false; }
      }
      return true;
    },
  };
}
/** "Is any segment closer than d?" for d up to `cell`. */
function segHash(segs, cell) {
  const m = new Map();
  const key = (gx, gy) => gx * 100003 + gy;
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s[0], s[2]) / cell), x1 = Math.floor(Math.max(s[0], s[2]) / cell);
    const y0 = Math.floor(Math.min(s[1], s[3]) / cell), y1 = Math.floor(Math.max(s[1], s[3]) / cell);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) { const k = key(gx, gy); (m.get(k) ?? m.set(k, []).get(k)).push(i); }
  });
  return (x, y, d) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++)
      for (const si of m.get(key(i, j)) ?? []) { const s = segs[si]; if (segDist(x, y, s[0], s[1], s[2], s[3]) < d) return true; }
    return false;
  };
}
const segsOf = (lines) => lines.flatMap((l) => l.slice(1).map((p, i) => [l[i][0], l[i][1], p[0], p[1]]));
function hash2(ix, iy) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const fbm = (x, y) => 0.65 * vnoise(x, y) + 0.35 * vnoise(x * 2.3 + 17.1, y * 2.3 - 9.4);
const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 0.5;

const tBox = tracts.map((t) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of t.polys) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
});
const tractAtFast = (x, y) => {
  for (let i = 0; i < tracts.length; i++) {
    const b = tBox[i];
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    if (tracts[i].polys.some((poly) => pointInPoly(x, y, poly))) return i;
  }
  return -1;
};
for (const t of tracts) t.dens = t.pop / Math.max(0.05, t.aland / 1e6); // people per km²
const lakeBox = lakes.map((poly) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
});
const inLakeFast = (x, y) => lakes.some((poly, i) => { const b = lakeBox[i]; return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && pointInPoly(x, y, poly); });
const nearLocal = segHash(localSegs, 0.5);
const nearRiver = segHash(segsOf(rivers), 1.0);
const nearCreek = segHash(segsOf(creeks), 0.5);
const dist0 = (x, y, p) => Math.hypot(x - p[0], y - p[1]);

// ---------- skylines beyond downtown: Uptown, Las Colinas, the Galleria ----------
const occ = pointHash(1.2);
for (const b of Object.values(BUILDINGS)) occ.add(b.at[0], b.at[1], 0.95);
occ.add(reunion[0], reunion[1], 0.4); occ.add(plant[0], plant[1], 1.7); occ.add(hub[0], hub[1], 0.8); occ.add(waterTower[0], waterTower[1], 0.35);
// downtown: towers on the real blocks, tallest in the middle
for (let tries = 0; TOWERS.length < 34 && tries < 6000; tries++) {
  const x = downtown[0] + gauss() * 0.42, y = downtown[1] + gauss() * 0.42, d = dist0(x, y, downtown);
  if (d > 1.05 || nearMajor(x, y, 0.09) || nearLocal(x, y, 0.045) || !occ.free(x, y, 0.1)) continue;
  occ.add(x, y, 0.1);
  TOWERS.push([r2(x), r2(y), r2((0.35 + 1.85 * Math.exp(-(d * d) / 0.18)) * (0.55 + 0.45 * rnd()))]);
}
const towers2 = [];
for (const [lat, lon, count, maxH, rad] of [[32.7990, -96.8030, 9, 1.3, 0.6], [32.8770, -96.9400, 7, 1.1, 0.7], [32.9290, -96.8190, 6, 1.0, 0.5], [32.9900, -96.7520, 3, 0.7, 0.4]]) {
  const c = LL(lat, lon);
  for (let n = 0, tries = 0; n < count && tries < 400; tries++) {
    const x = c[0] + gauss() * rad * 0.6, y = c[1] + gauss() * rad * 0.6;
    if (inLakeFast(x, y) || nearMajor(x, y, 0.1) || nearLocal(x, y, 0.05) || !occ.free(x, y, 0.13)) continue;
    const k = circuitOfPoint(x, y);
    if (k < 0) continue;
    occ.add(x, y, 0.13);
    towers2.push([r2(x), r2(y), r2(maxH * (n === 0 ? 1 : 0.4 + 0.5 * rnd())), k]);
    n++;
  }
}

// ---------- homes: rows along the real local streets, in neighborhood clumps; the count follows tract population ----------
// kind 0 house, 1 apartment block, 2 shop, 3 industrial
const PEOPLE_PER_HOME = 70;
const DT_CORE = 1.15;
const homes = [];
const segsByTract = new Map();
for (const s of localSegs) {
  const ti = tractAtFast((s[0] + s[2]) / 2, (s[1] + s[3]) / 2);
  if (ti >= 0) (segsByTract.get(ti) ?? segsByTract.set(ti, []).get(ti)).push(s);
}
tracts.forEach((t, ti) => {
  const segs = segsByTract.get(ti);
  if (!segs || t.pop <= 0) return;
  const k = assign[ti];
  const aptShare = t.dens > 4500 ? 0.45 : t.dens > 3000 ? 0.22 : t.dens > 2000 ? 0.08 : 0.015;
  const slots = [];
  for (const [ax, ay, bx, by] of segs) {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.15) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    for (const side of [1, -1]) {
      const nx = -uy * side, ny = ux * side;
      for (let d = 0.05 + rnd() * 0.06; d < len - 0.04; d += 0.12 + rnd() * 0.03) {
        const apt = rnd() < aptShare;
        const off = (apt ? 0.12 : 0.085) + (rnd() - 0.5) * 0.012;
        const x = ax + ux * d + nx * off, y = ay + uy * d + ny * off;
        slots.push({ x, y, a: Math.atan2(-nx, -ny), apt, n: fbm(x / 0.9, y / 0.9) + rnd() * 0.06 });
      }
    }
  }
  slots.sort((p, q) => q.n - p.n);
  let want = Math.round(t.pop / PEOPLE_PER_HOME);
  for (const sl of slots) {
    if (want <= 0) break;
    const { x, y, apt } = sl, r = apt ? 0.085 : 0.055;
    if (dist0(x, y, downtown) < DT_CORE) continue;
    if (inLakeFast(x, y) || nearMajor(x, y, 0.12) || nearLocal(x, y, apt ? 0.075 : 0.05) || !occ.free(x, y, r)) continue;
    occ.add(x, y, r);
    homes.push([x, y, sl.a, k, apt ? 1 : 0, Math.floor(rnd() * 84)]);
    want -= apt ? 4 : 1;
  }
});
const nHouses = homes.length;

// shops along the arterials in built-up tracts
for (const line of highways) for (let i = 0; i < line.length - 1; i++) {
  const [ax, ay] = line[i], [bx, by] = line[i + 1], len = Math.hypot(bx - ax, by - ay);
  if (len < 0.2) continue;
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  for (const side of [1, -1]) {
    const nx = -uy * side, ny = ux * side;
    for (let d = rnd() * 0.2; d < len; d += 0.2 + rnd() * 0.1) {
      const x = ax + ux * d + nx * 0.14, y = ay + uy * d + ny * 0.14;
      const ti = tractAtFast(x, y);
      if (ti < 0 || tracts[ti].dens < 700 || fbm(x / 1.1 + 40, y / 1.1) < 0.52) continue;
      if (dist0(x, y, downtown) < DT_CORE || inLakeFast(x, y) || nearMajor(x, y, 0.1) || nearLocal(x, y, 0.07) || !occ.free(x, y, 0.08)) continue;
      occ.add(x, y, 0.08);
      homes.push([x, y, Math.atan2(-nx, -ny), assign[ti], 2, Math.floor(rnd() * 14)]);
    }
  }
}
const nShops = homes.length - nHouses;

// industry: low-density land near the core, along the freeways (Stemmons, the Trinity industrial district, South Dallas)
let nInd = 0;
for (let tries = 0; nInd < 320 && tries < 120000; tries++) {
  const x = rnd() * W, y = rnd() * H, dc = dist0(x, y, downtown);
  if (dc > 18 || dc < 2.6) continue;
  const ti = tractAtFast(x, y);
  if (ti < 0 || tracts[ti].dens > 450) continue;
  if (!nearMajor(x, y, 0.8) || nearMajor(x, y, 0.16) || fbm(x / 1.0 - 30, y / 1.0 + 12) < 0.5) continue;
  if (inLakeFast(x, y) || nearRiver(x, y, 0.5) || nearLocal(x, y, 0.1) || !occ.free(x, y, 0.2)) continue;
  occ.add(x, y, 0.2);
  homes.push([x, y, (Math.floor(rnd() * 4) * Math.PI) / 2 + 0.3, assign[ti], 3, Math.floor(rnd() * 19)]);
  nInd++;
}
console.log(`${nHouses} homes on streets, ${nShops} shops, ${nInd} industrial, ${towers2.length} extra towers`);

// ---------- trees: along creeks and the Trinity, around lakes, in yards and woodland clumps ----------
const trees = [];
const tocc = pointHash(1.2);
const MAX_TREES = 18000;
const addTree = (x, y, s) => {
  if (trees.length >= MAX_TREES || tractAtFast(x, y) < 0) return;
  if (inLakeFast(x, y) || nearMajor(x, y, 0.09) || nearLocal(x, y, 0.035) || !occ.free(x, y, 0.025) || !tocc.free(x, y, 0.024)) return;
  tocc.add(x, y, 0.024);
  trees.push([x, y, s]);
};
const walk = (lines, step, fn) => {
  for (const l of lines) for (let i = 0; i < l.length - 1; i++) {
    const [ax, ay] = l[i], [bx, by] = l[i + 1], len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const nx = -(by - ay) / len, ny = (bx - ax) / len;
    for (let d = rnd() * step; d < len; d += step) fn(ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len, nx, ny);
  }
};
// the Great Trinity Forest: the river bottoms south-east of downtown
const forest = (x, y) => y > downtown[1] + 0.8 && y < downtown[1] + 9 && x > downtown[0] - 1 && x < downtown[0] + 9;
walk(rivers, 0.04, (x, y, nx, ny) => {
  const wide = forest(x, y) ? 1.5 : 0.45;
  for (let j = 0; j < (forest(x, y) ? 6 : 2); j++) { const o = gauss() * wide; addTree(x + nx * o, y + ny * o, 0.38 + rnd() * 0.22); }
});
walk(creeks, 0.05, (x, y, nx, ny) => { for (let j = 0; j < 2; j++) { const o = gauss() * 0.16; addTree(x + nx * o, y + ny * o, 0.34 + rnd() * 0.2); } });
walk(lakes.map((poly) => poly[0]), 0.06, (x, y, nx, ny) => { if (rnd() < 0.8) { const o = (rnd() < 0.5 ? 1 : -1) * (0.05 + rnd() * 0.3); addTree(x + nx * o, y + ny * o, 0.34 + rnd() * 0.2); } });
for (const h of homes) if (h[4] === 0 && rnd() < 0.3) {
  const fx = Math.sin(h[2]), fy = Math.cos(h[2]), lat = (rnd() - 0.5) * 0.1;
  addTree(h[0] - fx * 0.075 + fy * lat, h[1] - fy * 0.075 - fx * lat, 0.3 + rnd() * 0.16);
}
for (let tries = 0; tries < 160000 && trees.length < MAX_TREES; tries++) {
  const x = rnd() * W, y = rnd() * H;
  if (fbm(x / 1.6 + 90, y / 1.6 - 40) < 0.6) continue;
  const ti = tractAtFast(x, y);
  if (ti < 0 || tracts[ti].dens > 1800) continue;
  addTree(x, y, 0.36 + rnd() * 0.24);
}
console.log(`${trees.length} trees`);
const q16 = (v, max) => Math.max(0, Math.min(65535, Math.round((v / max) * 65535)));
const homesBin = new Uint16Array(homes.length * 6);
homes.forEach(([x, y, a, k, kind, v], i) => {
  homesBin.set([q16(x, W), q16(y, H), Math.round((((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 65535), k, kind, v], i * 6);
});
// homes.bin is retired: the game draws the real buildings (prep-buildings.mjs)
const treesBin = new Uint16Array(trees.length * 3);
trees.forEach(([x, y, s], i) => treesBin.set([q16(x, W), q16(y, H), Math.round(s * 1000)], i * 3));
// trees.bin now comes from prep-buildings.mjs

// ---------- land use for the ground: tract density, airports with runways, parks, campuses, cemeteries ----------
const LU = { K2457: 'air', K2180: 'park', K2188: 'park', K2561: 'golf', K2582: 'cemetery', K2540: 'campus' };
const RUNWAYS = { 'Dallas Love Fld': [[133, 0.24, 2.7], [133, -0.24, 2.3]], 'Addison Arprt': [[155, 0, 1.9]] };
const landuse = [];
for (const f of await readShp('arealm/tl_2024_48_arealm', (p) => LU[p.MTFCC])) {
  const polys = ringsOf(f.geometry).map((poly) => poly.map((ring) => ring.map(P)));
  if (!polys.some((poly) => poly[0].some(([x, y]) => x > 0 && x < W && y > 0 && y < H))) continue;
  const item = { k: LU[f.properties.MTFCC], polys: polys.map((poly) => poly.map((ring) => dpRing(ring, 0.02).map(([x, y]) => [r2(x), r2(y)]))) };
  const rw = RUNWAYS[f.properties.FULLNAME];
  if (rw) {
    let cx = 0, cy = 0;
    for (const [x, y] of polys[0][0]) { cx += x; cy += y; }
    cx /= polys[0][0].length; cy /= polys[0][0].length;
    item.runways = rw.map(([hdg, lat, len]) => {
      const dx = Math.sin((hdg * Math.PI) / 180), dy = -Math.cos((hdg * Math.PI) / 180);
      const ox = cx - dy * lat, oy = cy + dx * lat;
      return [r2(ox - (dx * len) / 2), r2(oy - (dy * len) / 2), r2(ox + (dx * len) / 2), r2(oy + (dy * len) / 2)];
    });
  }
  landuse.push(item);
}
const tractGround = tracts.map((t) => [Math.round(t.dens), t.polys.map((poly) => poly.map((ring) => dpRing(ring, 0.03).map(([x, y]) => [r2(x), r2(y)])))]);
console.log(`${landuse.length} land-use areas (${landuse.filter((l) => l.k === 'air').length} airports)`);

// streetlights along the major roads, each tied to the circuit it sits in
const lamps = [];
for (const line of [...interstates, ...highways]) {
  let carry = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1], len = Math.hypot(bx - ax, by - ay);
    for (let s = carry; s < len; s += 1.6) {
      const x = ax + ((bx - ax) * s) / len, y = ay + ((by - ay) * s) / len;
      const k = circuitOfPoint(x, y);
      if (k >= 0) lamps.push([r2(x), r2(y), k]);
    }
    carry = (carry - len) % 1.6;
    if (carry < 0) carry += 1.6;
  }
}

// cars drive along the longest interstate lines
const carPaths = interstates.map((l) => ({ l, len: l.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0) }))
  .sort((a, b) => b.len - a.len).slice(0, 14).map((x) => x.l);

// circuit summary: centroid of population, a label spot, real totals for reference
const circuits = {};
CIRCUITS.forEach((c, k) => {
  let sx = 0, sy = 0, sp = 0, rpl = 0, rn = 0, realPop = 0;
  tracts.forEach((t, i) => {
    if (assign[i] !== k) return;
    sx += t.c[0] * (t.pop + 1); sy += t.c[1] * (t.pop + 1); sp += t.pop + 1; realPop += t.pop;
    if (t.rpl != null) { rpl += t.rpl * t.pop; rn += t.pop; }
  });
  const center = c.id === 'C-01' ? downtown : c.seed; // the real neighborhood; pinned into this circuit
  circuits[c.id] = { center: center.map(r2), realPop, svi: rn ? Math.round((rpl / rn) * 100) / 100 : null };
});

const PLACES = [
  ['Irving', 32.8140, -96.9489], ['Grand Prairie', 32.7460, -96.9978], ['Garland', 32.9126, -96.6389], ['Mesquite', 32.7668, -96.5992],
  ['Richardson', 32.9483, -96.7299], ['Carrollton', 32.9756, -96.8899], ['DeSoto', 32.5899, -96.8570], ['Lancaster', 32.5921, -96.7561],
  ['Cedar Hill', 32.5885, -96.9561], ['Duncanville', 32.6518, -96.9083], ['Rowlett', 32.9029, -96.5639], ['Farmers Branch', 32.9265, -96.8961],
  ['White Rock Lake', 32.8260, -96.7230], ['Lake Ray Hubbard', 32.8650, -96.5300], ['Joe Pool Lake', 32.6200, -97.0000], ['Mountain Creek Lake', 32.7300, -96.9600],
  ['Trinity River', 32.7700, -96.8350],
  // more suburbs
  ['Addison', 32.9618, -96.8292], ['University Park', 32.8501, -96.8000], ['Highland Park', 32.8337, -96.7919], ['Coppell', 32.9546, -97.0150],
  ['Balch Springs', 32.7287, -96.6228], ['Seagoville', 32.6396, -96.5383], ['Sachse', 32.9762, -96.5953], ['Hutchins', 32.6493, -96.7130],
  ['Wilmer', 32.5890, -96.6853], ['Glenn Heights', 32.5487, -96.8567], ['Sunnyvale', 32.7965, -96.5608],
  // Dallas neighborhoods and places people know
  ['Love Field', 32.8471, -96.8518], ['Uptown', 32.7990, -96.8030], ['Deep Ellum', 32.7840, -96.7830], ['Bishop Arts', 32.7490, -96.8280],
  ['Lakewood', 32.8180, -96.7480], ['Fair Park', 32.7790, -96.7600], ['Las Colinas', 32.8770, -96.9400],
].map(([name, lat, lon]) => { const [x, y] = LL(lat, lon); return { name, x: r2(x), z: r2(y) }; })
  .filter((p) => countyPolys.some((poly) => pointInPoly(p.x, p.z, poly)));
// which suburbs each circuit reaches into (for the neighborhood card)
const CITIES = new Set(['Irving', 'Grand Prairie', 'Garland', 'Mesquite', 'Richardson', 'Carrollton', 'DeSoto', 'Lancaster', 'Cedar Hill', 'Duncanville',
  'Rowlett', 'Farmers Branch', 'Addison', 'University Park', 'Highland Park', 'Coppell', 'Balch Springs', 'Seagoville', 'Sachse', 'Hutchins', 'Wilmer',
  'Glenn Heights', 'Sunnyvale']);
for (const c of Object.values(circuits)) c.covers = [];
for (const p of PLACES) {
  if (!CITIES.has(p.name)) continue;
  const k = circuitOfPoint(p.x, p.z);
  if (k >= 0) circuits[CIRCUITS[k].id].covers.push(p.name);
}

const small = {
  units: { miPerUnit: MI_PER_UNIT, w: r2(W), h: r2(H), lon: [lonMin, lonMax], lat: [latMin, latMax] },
  circuits,
  buildings: Object.fromEntries(Object.entries(BUILDINGS).map(([id, b]) => [id, b.at.map(r2)])),
  towers: TOWERS, reunion: reunion.map(r2), plant: plant.map(r2), waterTower: waterTower.map(r2), hub: hub.map(r2),
  lamps, places: PLACES,
};
writeFileSync(OUT_SRC, JSON.stringify(small));
const big = {
  county: countyPolys.map((poly) => poly.map((ring) => ring.map(([x, y]) => [r2(x), r2(y)]))),
  plates, outlines, lakes, rivers, creeks, interstates, highways, carPaths, towers2, landuse, tracts: tractGround,
  homes: { count: homes.length, qx: r2(W), qz: r2(H) },
  streets: { count: streetSegs.length / 4, qx: r2(W), qz: r2(H) },
};
writeFileSync(`${OUT_PUB}dallas.json`, JSON.stringify(big));
console.log('wrote', OUT_SRC, `${(JSON.stringify(small).length / 1024).toFixed(0)} KB;`, `dallas.json ${(JSON.stringify(big).length / 1024).toFixed(0)} KB; streets.bin ${(streetSegs.length * 2 / 1024).toFixed(0)} KB`);
console.log('circuits:', Object.entries(circuits).map(([id, c]) => `${id} ${(c.realPop / 1000).toFixed(0)}k svi ${c.svi}`).join(' | '));
