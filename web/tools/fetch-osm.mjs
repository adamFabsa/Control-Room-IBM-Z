// Downloads the real building outlines (and campus, stadium and woodland areas) for Dallas County from
// OpenStreetMap through the Overpass API. Data © OpenStreetMap contributors, ODbL.
// Run once: node tools/fetch-osm.mjs   → ../data/osm/*.json (skips tiles it already has)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../../data/osm/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const S = 32.545, N = 32.990, W = -97.039, E = -96.517, T = 6;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function query(q, file) {
  if (existsSync(file)) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    const ep = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(ep, { method: 'POST', headers: { 'User-Agent': 'control-room-uri-datathon/1.0', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
      const text = await res.text();
      if (!res.ok || !text.startsWith('{') || text.includes('"remark": "runtime error')) throw new Error(`${res.status} ${text.slice(0, 160)}`);
      writeFileSync(file, text);
      console.log('saved', file.split('/').pop(), `${(text.length / 1e6).toFixed(1)} MB`);
      return;
    } catch (e) {
      console.log('retry', file.split('/').pop(), String(e).slice(0, 200));
      await wait(15000 * (attempt + 1));
    }
  }
  throw new Error('gave up on ' + file);
}

const bb = (s, w, n, e) => `(${s},${w},${n},${e})`;
await query(`[out:json][timeout:300];(
  nwr["amenity"~"^(university|college)$"]${bb(S, W, N, E)};
  nwr["leisure"="stadium"]${bb(S, W, N, E)};
  way["landuse"="forest"]${bb(S, W, N, E)}; relation["landuse"="forest"]${bb(S, W, N, E)};
  way["natural"="wood"]${bb(S, W, N, E)}; relation["natural"="wood"]${bb(S, W, N, E)};
);out tags geom;`, `${OUT}areas.json`);
for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) {
  const s = S + ((N - S) * i) / T, n = S + ((N - S) * (i + 1)) / T, w = W + ((E - W) * j) / T, e = W + ((E - W) * (j + 1)) / T;
  await query(`[out:json][timeout:300];(way["building"]${bb(s, w, n, e)};relation["building"]${bb(s, w, n, e)};);out tags geom qt;`, `${OUT}b_${i}_${j}.json`);
  await wait(2000);
}
console.log('done');
