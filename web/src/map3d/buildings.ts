// Every real building in Dallas County, from OpenStreetMap outlines, at true size in its real place
// (see tools/prep-buildings.mjs). About 650,000 of them:
// - simple ones are oriented boxes with a hip, gable or flat roof, drawn instanced straight from the
//   16-byte records in rects.bin (the shader unpacks position, size, height, roof and style)
// - large irregular ones (towers, campus halls, malls) keep their real outline, extruded
// - trees in yards, woods, along creeks and in parks
// Big buildings are always drawn; houses and trees grow in as you zoom in (the ground texture carries
// their footprints from afar). Window lights follow each neighborhood's power on the GPU: a cut ripples
// out from where power feeds the neighborhood, window by window.
import * as THREE from 'three';

/** Vertical exaggeration: heights read a little taller than life from the 30° camera. */
export const VEX = 1.5;
/** Seconds for a cut (or a restore) to sweep across a neighborhood. */
export const WAVE = 1.8;
const MAX_CIRCUITS = 16;
// houses and trees grow in once they're a couple of pixels across (below that, the painted footprints
// show them: sub-pixel triangles are the slowest thing a GPU can draw)
export const SMALL_ZOOM = 4.5;
export const TREE_ZOOM = 5.5;

export const KIND = { HOUSE: 0, APT: 1, COM: 2, IND: 3, CIVIC: 4, UNI: 5, TOWER: 6, SMALL: 7 } as const;

interface Chunk { big: number; start: number; count: number; off: number; len: number; box: [number, number, number, number]; hMax: number }
export interface BuildingIndex {
  metersPerUnit: number;
  rects: { count: number; chunks: Chunk[] };
  polys: { count: number; words: number; chunks: Chunk[] };
  trees: { count: number; chunks: { start: number; count: number; box: [number, number, number, number] }[] };
  campuses: { name: string; x: number; z: number; a: number }[];
  named: { name: string; x: number; z: number; h: number; a: number }[];
}
export interface BuildingData { index: BuildingIndex; rects: Uint16Array; polys: Uint16Array; trees: Uint16Array; w: number; h: number }

export async function loadBuildings(base: string): Promise<BuildingData> {
  const bin = (name: string) => fetch(`${base}geo/${name}`).then((r) => r.arrayBuffer());
  const [index, rects, polys, trees] = await Promise.all([
    fetch(`${base}geo/buildings.json`).then((r) => r.json() as Promise<BuildingIndex>), bin('rects.bin'), bin('polys.bin'), bin('trees.bin'),
  ]);
  return { index, rects: new Uint16Array(rects), polys: new Uint16Array(polys), trees: new Uint16Array(trees), w: 0, h: 0 };
}

// ---------- colors: Dallas brick and siding, asphalt shingles, white membrane roofs ----------
// rows: kind × (walls, roofs); 16 variants each (lists repeat to fill)
const PALETTE: [string[], string[]][] = [
  [['#c27f63', '#b07a62', '#d8bd9c', '#ebe3d0', '#f2efe8', '#cfc8bc', '#e3d2b2', '#bcc3ad', '#c98f6d', '#dfd0b4', '#b98a70', '#efe9dc'],
    ['#8f8880', '#9d9184', '#80818a', '#a89887', '#7a7d84', '#999189', '#8a837b', '#ab9c8b']], // house: brick, stone, siding; shingles
  [['#dccab0', '#cfae94', '#e6ddcf', '#bfae98', '#ddd5c4', '#d2c2a8', '#c08d74'], ['#9a938b', '#8d9096', '#a59e96', '#939ca3']], // apartments
  [['#e2ddd3', '#d6ccb9', '#cbcdca', '#ebe6dc', '#bdb8af', '#ddd3c0', '#cfc5b4'], ['#ededea', '#d9d9d5', '#c6c6c2', '#e4e2dc', '#a9a9a6']], // commercial
  [['#e5e2da', '#d9d6ce', '#d0d4d6', '#ecebe6', '#cac7bf'], ['#f0f0ec', '#e1e1dd', '#d1d2d2', '#f2f2ee']], // industrial
  [['#c47a5f', '#d8c7ab', '#e6e1d6', '#b86c53', '#ddd3c2'], ['#8a8784', '#e2e2de', '#958a81', '#d6d6d2']], // civic
  [['#b8644d', '#ad5d48', '#c46f56', '#b96a50', '#d9c6a7', '#cbb89c', '#e3dbcc', '#b26b52'], ['#737980', '#7d8288', '#6c7178', '#81868c', '#e3e3df', '#d2d2ce', '#7a7f85', '#dcdcd8']], // campus (SMU first: red brick, slate)
  [['#7d98ab', '#6a8597', '#9aaebb', '#5b7586', '#a9b8c2', '#89a4b4', '#71909f', '#b5c3cc'], ['#7b8188', '#8a9097', '#9aa0a6']], // towers
  [['#ddd6c9', '#c9c2b6', '#b5a594', '#e6e1d7'], ['#8f8a85', '#a8a39e', '#7e7e80']], // garages, sheds
];
function paletteTexture(): THREE.DataTexture {
  const data = new Uint8Array(16 * 16 * 4);
  PALETTE.forEach(([walls, roofs], k) => {
    for (let v = 0; v < 16; v++) {
      for (const [row, list] of [[k * 2, walls], [k * 2 + 1, roofs]] as const) {
        const hex = parseInt(list[v % list.length].slice(1), 16); // raw sRGB bytes: the GPU decodes them
        const o = (row * 16 + v) * 4;
        data[o] = hex >> 16; data[o + 1] = (hex >> 8) & 255; data[o + 2] = hex & 255; data[o + 3] = 255;
      }
    }
  });
  const t = new THREE.DataTexture(data, 16, 16);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

// ---------- shader pieces ----------
const LIGHT_GLSL = /* glsl */ `
  uniform float uFrom[${MAX_CIRCUITS}];
  uniform float uTo[${MAX_CIRCUITS}];
  uniform float uT0[${MAX_CIRCUITS}];
  uniform vec2 uCenter[${MAX_CIRCUITS}];
  uniform float uReach[${MAX_CIRCUITS}];
  uniform float uTime;
  uniform vec2 uWorld;
  uniform float uMPU;
  uniform float uVex;
  uniform float uGrow;
  varying vec4 vInfo; // kind, variant, lit, seed
  varying vec3 vWin;  // along the wall (m), height (m; on roofs: above the eaves), 1 on roofs
  varying vec4 vD;    // walls: front face?, face length (m), wall height (m); roofs: -, -, local x, z (m)
  varying vec3 vDim;  // footprint long side, short side (m), roof shape (0 flat, 1 gable, 2 hip)
  float seqOff(float p) { int i = int(min(4.0, floor(p * 5.0))); return i == 0 ? 1.0 : i == 1 ? 0.2 : i == 2 ? 0.85 : i == 3 ? 0.1 : 0.0; }
  float seqOn(float p) { int i = int(min(4.0, floor(p * 5.0))); return i == 0 ? 0.0 : i == 1 ? 0.6 : i == 2 ? 0.15 : i == 3 ? 0.9 : 1.0; }
  float litAt(float circ, vec2 at, float seed) {
    int c = int(circ + 0.5);
    float delay = clamp(length(at - uCenter[c]) / max(uReach[c], 0.1), 0.0, 1.0);
    float t0 = uT0[c] + delay * ${WAVE.toFixed(2)} + fract(seed * 3.7) * 0.15; // a wave out from the feed point
    if (uTime < t0) return uFrom[c];
    float p = (uTime - t0) / 0.3;
    if (p >= 1.0) return uTo[c];
    return uTo[c] < 0.5 ? seqOff(p) : seqOn(p);
  }
  float seedOf(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

/** Boxes: unpack one 16-byte record into a building. */
const RECT_UNPACK = /* glsl */ `
  float bx = iA.x / 65535.0 * uWorld.x;
  float bz = iA.y / 65535.0 * uWorld.y;
  float ang = iA.z / 65535.0 * 3.14159265;
  float wM = iA.w * 0.1, dM = iB.x * 0.1, hM = iB.y * 0.1;
  float st = iB.z;
  float kind = mod(st, 8.0);
  float roof = mod(floor(st / 8.0), 4.0);
  float variant = mod(floor(st / 32.0), 16.0);
  float facing = mod(floor(st / 512.0), 4.0); // which side faces the street
  float ca = cos(ang), sa = sin(ang);
`;
const RECT_VERTEX = /* glsl */ `
  ${RECT_UNPACK}
  float bw = wM / uMPU, bd = dM / uMPU, bh = hM * uVex / uMPU * uGrow;
  float pitchM = roof < 0.5 ? 0.0 : min(dM * 0.24, 5.0); // about a 6:12 roof
  float pitch = pitchM * uVex / uMPU * uGrow;
  // pitched roofs overhang the walls by half a metre (hips on all four sides, gables on the long ones);
  // the walls rise to meet the roof so there's no gap under the eaves
  float isHip = step(1.5, roof);
  float ovM = roof < 0.5 ? 0.0 : 0.5;
  float ov = ovM / uMPU;
  float rise = pitch * ovM / (dM * 0.5 + ovM + 0.001);
  float ridgeM = (roof > 0.5 && roof < 1.5) ? wM * 0.5 : max(0.0, (wM - dM) * 0.5);
  vec3 lp;
  if (aPart < 0.5) lp = vec3(position.x * bw, position.y * (bh + rise), position.z * bd);
  else if (aPart < 1.5) lp = vec3(position.x * bw, position.y * (bh + rise * isHip), position.z * bd);
  else if (aPart < 2.5) lp = vec3(position.x * (bw + 2.0 * ov * isHip), bh, position.z * (bd + 2.0 * ov));
  else lp = vec3(sign(position.x) * ridgeM / uMPU, bh + pitch, 0.0);
  vec3 transformed = vec3(bx + lp.x * ca - lp.z * sa, lp.y, bz + lp.x * sa + lp.z * ca);
`;
const RECT_VARY = /* glsl */ `
  float seed = seedOf(vec2(bx, bz));
  vInfo = vec4(kind, variant, litAt(iB.w, vec2(bx, bz), seed), seed);
  float yM = lp.y * uMPU / max(uVex * uGrow, 0.001);
  float topM = hM + rise * uMPU / max(uVex * uGrow, 0.001);
  float side = aPart < 0.5 ? (position.z > 0.0 ? 0.0 : 1.0) : (position.x > 0.0 ? 2.0 : 3.0);
  float isFront = 1.0 - step(0.5, abs(side - facing));
  if (aPart < 0.5) { vWin = vec3((position.x + 0.5) * wM, yM, 0.0); vD = vec4(isFront, wM, topM, 0.0); }
  else if (aPart < 1.5) { vWin = vec3((position.z + 0.5) * dM, yM, 0.0); vD = vec4(isFront, dM, hM + isHip * (topM - hM), 0.0); }
  else { vWin = vec3(0.0, yM - hM, 1.0); vD = vec4(0.0, 0.0, lp.x * uMPU + wM * 0.5, lp.z * uMPU + dM * 0.5); }
  vDim = vec3(wM, dM, roof);
`;
const POLY_VERTEX = /* glsl */ `
  vec3 transformed = vec3(position.x, position.y * uGrow, position.z);
`;
const POLY_VARY = /* glsl */ `
  float seed = aInfo.w / 255.0;
  vInfo = vec4(aInfo.x, aInfo.y, litAt(aInfo.z, position.xz, seed), seed);
  vWin = aU < 0.0 ? vec3(0.0, 0.0, 1.0) : vec3(aU, position.y * uMPU / uVex, 0.0);
  vD = aU < 0.0 ? vec4(0.0, 0.0, position.x * uMPU, position.z * uMPU) : vec4(0.0, 0.0, aTop, 0.0);
  vDim = vec3(0.0);
`;
/** Rooftop extras from the same records: a chimney on some houses, AC units and a stair penthouse on flat roofs. */
const EXTRA_VERTEX = /* glsl */ `
  ${RECT_UNPACK}
  float seed = seedOf(vec2(bx, bz));
  float h1 = fract(seed * 13.17), h2 = fract(seed * 7.31), h3 = fract(seed * 3.97);
  vec3 sz = vec3(0.0);
  vec2 off = vec2(0.0);
  vExtra = vec3(0.78, 0.79, 0.8);
  if (kind < 0.5 && roof > 0.5 && aBox < 0.5 && h1 < 0.5) {
    float pitchM = min(dM * 0.24, 5.0);
    sz = vec3(0.9, pitchM + 1.1, 0.9);
    off = vec2((h2 - 0.5) * wM * 0.55, dM * 0.16);
    vExtra = h3 < 0.6 ? vec3(0.55, 0.32, 0.25) : vec3(0.7, 0.66, 0.6);
  } else if (roof < 0.5 && kind > 0.5 && kind < 6.5 && dM > 9.0) {
    if (aBox < 0.5) { sz = vec3(2.6, 1.3, 1.7); off = vec2((h1 - 0.5) * (wM - 6.0), (h2 - 0.5) * (dM - 5.0)); }
    else if (aBox < 1.5 && wM > 16.0) { sz = vec3(2.0, 1.1, 1.5); off = vec2((h3 - 0.5) * (wM - 6.0), (fract(h1 + 0.37) - 0.5) * (dM - 5.0)); }
    else if (aBox > 1.5 && hM > 9.0 && dM > 12.0) {
      sz = vec3(3.6, 2.8, 3.6); off = vec2((fract(h2 + 0.5) - 0.5) * (wM - 8.0), (fract(h3 + 0.2) - 0.5) * (dM - 8.0));
      vExtra = vec3(0.7, 0.69, 0.66);
    }
  }
  vec3 transformed;
  if (sz.x == 0.0) transformed = vec3(bx, -1.0, bz); // nothing here: collapse to a point
  else {
    vec3 lp = vec3((off.x + position.x * sz.x) / uMPU, (hM + position.y * sz.y) * uVex / uMPU * uGrow, (off.y + position.z * sz.z) / uMPU);
    transformed = vec3(bx + lp.x * ca - lp.z * sa, lp.y, bz + lp.x * sa + lp.z * ca);
  }
`;
const TREE_VERTEX = /* glsl */ `
  float tx = iT.x / 65535.0 * uWorld.x, tz = iT.y / 65535.0 * uWorld.y;
  float tr = iT.z / 100.0 / uMPU * uGrow;
  vec3 transformed = aTrunk > 0.5
    ? vec3(tx + position.x * tr * 0.09, position.y * 0.62 * tr * uVex, tz + position.z * tr * 0.09)
    : vec3(tx + position.x * tr, (position.y * 0.62 + 1.15) * tr * uVex, tz + position.z * tr);
`;

const BUILDING_FRAG = /* glsl */ `
  uniform sampler2D uPal;
  uniform float uNight;
  uniform float uBright;
  uniform float uSnow;
  varying vec4 vInfo;
  varying vec3 vWin;
  varying vec4 vD;
  varying vec3 vDim;
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise2(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
  }
  /** 1 inside [lo, hi], softened over e (anti-aliased) */
  float band(float x, float lo, float hi, float e) { return smoothstep(lo - e, lo + e, x) * (1.0 - smoothstep(hi - e, hi + e, x)); }
  /** fades a detail of this size (m) in once it spans a few pixels */
  float vis(float size, float pxm) { return 1.0 - smoothstep(size * 0.22, size * 0.5, pxm); }
  // per kind: floor height, window bottom, window top (m within a floor), bay width (m)
  const vec4 WA[8] = vec4[8](vec4(3.0, 0.9, 2.1, 3.6), vec4(3.1, 0.8, 2.2, 3.0), vec4(3.8, 0.5, 3.1, 3.2), vec4(7.0, 4.2, 5.4, 9.0),
                             vec4(4.0, 1.1, 3.1, 3.4), vec4(3.8, 1.0, 2.9, 3.0), vec4(3.8, 0.25, 3.55, 1.6), vec4(3.0, 9.0, 9.0, 4.0));
  // per kind: window width (share of a bay), share of windows lit at night
  const vec2 WB[8] = vec2[8](vec2(0.36, 0.62), vec2(0.45, 0.55), vec2(0.62, 0.3), vec2(0.25, 0.12), vec2(0.45, 0.3), vec2(0.42, 0.4), vec2(0.8, 0.17), vec2(0.0, 0.0));
  const vec3 DOORS[4] = vec3[4](vec3(0.3, 0.19, 0.13), vec3(0.42, 0.12, 0.1), vec3(0.13, 0.18, 0.27), vec3(0.12, 0.12, 0.13));
  const vec3 SIGNS[5] = vec3[5](vec3(0.66, 0.15, 0.13), vec3(0.14, 0.3, 0.55), vec3(0.16, 0.42, 0.24), vec3(0.85, 0.66, 0.2), vec3(0.92, 0.92, 0.9));
`;
const BUILDING_SHADE = /* glsl */ `
  {
    int kd = int(vInfo.x + 0.5);
    vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    float up = dot(normal, upV);
    float row = float(kd) * 2.0;
    float hb = fract(vInfo.w * 113.7); // one number per building
    vec3 col = texture2D(uPal, vec2((vInfo.y + 0.5) / 16.0, (row + 0.5) / 16.0)).rgb;
    col *= 0.95 + 0.1 * hb; // neighbors aren't stamped from one mould
    vec3 emit = vec3(0.0);
    if (up > 0.35) {
      // ---------- roofs ----------
      vec3 roofC = texture2D(uPal, vec2((vInfo.y + 0.5) / 16.0, (row + 1.5) / 16.0)).rgb;
      float pxr = max(fwidth(vD.z), fwidth(vD.w)) + 1e-4;
      if (vDim.z > 0.5) {
        // shingles: courses up the slope and tabs that vary a little in tone
        float course = vWin.y * 3.0;
        float k = vis(0.35, pxr);
        float tab = hash12(vec2(floor(course), floor(vD.z / 0.9 + floor(course) * 0.5)) + hb * 31.0);
        roofC *= mix(1.0, (0.9 + 0.1 * smoothstep(0.0, 0.45, fract(course))) * (0.93 + 0.14 * tab), k);
      } else if (vDim.x > 0.0) {
        // flat roofs: a parapet with coping, its shadow inside, membrane seams and weathering
        float e = min(min(vD.z, vDim.x - vD.z), min(vD.w, vDim.y - vD.w));
        float coping = 1.0 - smoothstep(0.35, 0.35 + pxr, e);
        float inner = smoothstep(0.3, 0.55, e) * (1.0 - smoothstep(0.55, 1.6, e));
        float seam = 1.0 - smoothstep(0.05, 0.05 + pxr, abs(fract(vD.z / 3.0 + 0.5) - 0.5) * 3.0);
        roofC = mix(roofC, roofC * 0.82 + 0.12, coping * vis(0.35, pxr));
        roofC *= 1.0 - (0.12 * inner * vis(0.6, pxr) + 0.05 * seam * vis(0.12, pxr));
        roofC *= 0.94 + 0.12 * vnoise2(vD.zw / 5.0 + hb * 50.0);
      } else {
        // big outlined roofs (their parapet is real geometry): membrane seams and weathering
        float seam = 1.0 - smoothstep(0.05, 0.05 + pxr, abs(fract(vD.z / 3.0 + 0.5) - 0.5) * 3.0);
        roofC *= 1.0 - 0.05 * seam * vis(0.12, pxr);
        roofC *= 0.93 + 0.14 * vnoise2(vD.zw / 6.0) * vis(3.0, pxr) + 0.0;
      }
      col = mix(roofC, vec3(0.93, 0.95, 0.98), uSnow * smoothstep(0.35, 0.75, up) * 0.92);
    } else if (vWin.z < 0.5) {
      // ---------- walls ----------
      vec4 A = WA[kd];
      vec2 B = WB[kd];
      float front = vD.x, faceLen = vD.y, topM = vD.z;
      float pxm = max(fwidth(vWin.x), fwidth(vWin.y)) + 1e-4; // metres per pixel
      // when bays get too small to draw, merge them in pairs (then fours…) so windows stay crisp blocks
      float merge = exp2(clamp(ceil(log2(fwidth(vWin.x / A.w) / 0.28 + 1e-6)), 0.0, 4.0));
      float bayW = A.w * merge;
      vec2 g = vec2(vWin.x / bayW, vWin.y / A.x);
      vec2 cell = floor(g), f = fract(g);
      float fy = f.y * A.x, fxm = f.x * bayW;
      vec2 fw = fwidth(g);
      float far = smoothstep(0.3, 0.7, max(fw.x, fw.y));
      float wx0 = (0.5 - B.x * 0.5) * bayW, wx1 = (0.5 + B.x * 0.5) * bayW;
      float win = band(fxm, wx0, wx1, pxm * 0.7) * band(fy, A.y, A.z, pxm * 0.7);
      float m = mix(win, B.x * clamp((A.z - A.y) / A.x, 0.0, 1.0), far);
      // no windows in the parapet or gable band at the top of the wall
      m *= 1.0 - smoothstep(topM - 0.35, topM - 0.15, vWin.y - fy + A.z);
      float ground = 1.0 - step(A.x, vWin.y);
      float on = step(hash12(cell + vInfo.w * 97.0), B.y);
      float lit = mix(on, B.y, far) * vInfo.z;
      float hl = hash12(cell + 3.1);
      vec3 bulb = mix(vec3(1.0, 0.66, 0.32), vec3(1.0, 0.84, 0.58), step(0.62, hl));
      if (kd == 6 || kd == 2) bulb = mix(vec3(0.72, 0.7, 0.62), vec3(0.95, 0.74, 0.46), step(0.55, hl)); // offices: dimmer, mixed
      vec3 glass = kd == 6 ? mix(vec3(0.45, 0.57, 0.68), vec3(0.05, 0.07, 0.11), uNight) : mix(vec3(0.3, 0.36, 0.43), vec3(0.04, 0.05, 0.08), uNight);

      // what the ground floor of the front holds
      float door = 0.0, garage = 0.0, shop = 0.0, sign = 0.0, dock = 0.0, porch = 0.0;
      if (front > 0.5 && kd == 0 && faceLen > 6.0) {
        float dx = faceLen * (0.28 + 0.14 * hb);
        door = band(vWin.x, dx - 0.5, dx + 0.5, pxm * 0.7) * band(vWin.y, 0.0, 2.1, pxm * 0.7);
        porch = 1.0 - smoothstep(0.12, 0.12 + pxm, length(vWin.xy - vec2(dx + 0.85, 2.0)));
        if (faceLen > 9.5 && hb > 0.22) {
          float gw = faceLen > 14.0 ? 5.0 : 2.7, gx = faceLen - gw - 0.9;
          garage = band(vWin.x, gx, gx + gw, pxm * 0.7) * band(vWin.y, 0.0, 2.3, pxm * 0.7);
          m *= 1.0 - band(vWin.x, gx - 0.5, gx + gw + 0.5, pxm) * ground;
        }
        m *= 1.0 - band(vWin.x, dx - 1.1, dx + 1.1, pxm) * ground;
      } else if (front > 0.5 && kd == 2) {
        // storefronts: tall glass with mullions every 3 m, and a sign band above
        shop = band(vWin.y, 0.35, 3.0, pxm * 0.7) * band(vWin.x, 0.6, faceLen - 0.6, pxm * 0.7);
        shop *= 1.0 - band(abs(fract(vWin.x / 3.0 + 0.5) - 0.5) * 3.0, -1.0, 0.07, pxm * 0.5) * vis(0.14, pxm);
        sign = band(vWin.y, 3.2, 3.9, pxm * 0.7) * band(vWin.x, faceLen * 0.2, faceLen * 0.8, pxm * 0.7);
        m *= 1.0 - step(vWin.y, 4.0);
      } else if (front > 0.5 && kd == 3) {
        // loading docks: roll-up doors every 11 m
        float u = fract(vWin.x / 11.0) * 11.0;
        dock = band(u, 3.7, 7.3, pxm * 0.7) * band(vWin.y, 0.0, 4.3, pxm * 0.7) * step(3.0, faceLen - vWin.x);
      }

      // window glass, trim and mullions (houses, apartments and campus halls have white or stone trim)
      col = mix(col, glass, m * 0.9);
      bool trimmed = kd == 0 || kd == 1 || kd == 5 || kd == 4;
      if (trimmed && merge < 1.5) {
        vec3 trimC = kd == 5 || kd == 4 ? vec3(0.84, 0.8, 0.72) : vec3(0.93, 0.92, 0.88);
        float frame = band(fxm, wx0 - 0.13, wx1 + 0.13, pxm * 0.6) * band(fy, A.y - 0.16, A.z + 0.1, pxm * 0.6) * (1.0 - win);
        float mull = win * max(1.0 - smoothstep(0.04, 0.04 + pxm, abs(fxm - (wx0 + wx1) * 0.5)),
                               1.0 - smoothstep(0.04, 0.04 + pxm, abs(fy - (A.y + A.z) * 0.5)));
        float k = (1.0 - far) * step(0.5, m + frame);
        col = mix(col, trimC, frame * vis(0.13, pxm) * k);
        col = mix(col, trimC, mull * vis(0.08, pxm) * (kd == 0 ? 1.0 : 0.6) * (1.0 - far));
        m *= 1.0 - mull * vis(0.08, pxm);
      }
      // floor lines on apartments, offices and halls
      if (kd >= 1 && kd <= 6 && kd != 3) col *= 1.0 - 0.1 * band(fy, -0.01, 0.22, pxm * 0.5) * vis(0.22, pxm) * step(A.x * 0.9, vWin.y);
      // ground-floor features
      vec3 dcol = DOORS[int(hb * 3.99)];
      col = mix(col, dcol, door * vis(1.0, pxm));
      float panels = 0.85 + 0.15 * smoothstep(0.0, 0.08, abs(fract(vWin.y / 0.55) - 0.5) * 0.55);
      col = mix(col, vec3(0.88, 0.87, 0.84) * panels, garage * vis(1.5, pxm));
      col = mix(col, vec3(0.74, 0.76, 0.78) * (0.88 + 0.12 * smoothstep(0.0, 0.1, abs(fract(vWin.y / 0.6) - 0.5))), dock * vis(1.5, pxm));
      col = mix(col, glass * 1.1, shop * vis(1.0, pxm));
      col = mix(col, SIGNS[int(fract(hb * 7.3) * 4.99)], sign * vis(0.7, pxm));
      // a foundation course at the base of houses
      if (kd == 0) col = mix(col, vec3(0.62, 0.61, 0.58), band(vWin.y, -1.0, 0.3, pxm * 0.5) * vis(0.3, pxm) * (1.0 - garage) * (1.0 - door));

      // night: windows, shop fronts, porch lights
      emit += bulb * (m * lit * uBright * uNight * (1.0 - 0.5 * far));
      float shopLit = step(hash12(vec2(floor(vWin.x / 6.0), hb * 17.0)), 0.55) * vInfo.z;
      emit += vec3(1.0, 0.86, 0.6) * shop * shopLit * uBright * uNight * 0.9;
      emit += SIGNS[int(fract(hb * 7.3) * 4.99)] * sign * vInfo.z * uNight * 0.9;
      emit += vec3(1.0, 0.72, 0.38) * porch * step(0.35, hb) * vInfo.z * uNight * 2.5 * vis(0.3, pxm);
      // a touch of contact shade where walls meet the ground, so buildings sit on it
      col *= mix(0.72, 1.0, smoothstep(0.0, 2.5, vWin.y));
    }
    totalEmissiveRadiance += emit;
    diffuseColor.rgb = col;
  }
`;
const EXTRA_FRAG = /* glsl */ `
  uniform float uSnow;
  varying vec3 vExtra;
`;
const EXTRA_SHADE = /* glsl */ `
  {
    vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    float up = dot(normal, upV);
    diffuseColor.rgb = mix(vExtra, vec3(0.93, 0.95, 0.98), uSnow * step(0.5, up) * 0.9);
  }
`;
const TREE_FRAG = /* glsl */ `
  uniform float uSnow;
  uniform float uMPU;
  varying float vTree;
  varying float vTrunk;
  varying vec3 vTP;
  float hashT(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float noiseT(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hashT(i), hashT(i + vec3(1, 0, 0)), f.x), mix(hashT(i + vec3(0, 1, 0)), hashT(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hashT(i + vec3(0, 0, 1)), hashT(i + vec3(1, 0, 1)), f.x), mix(hashT(i + vec3(0, 1, 1)), hashT(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
`;
const TREE_SHADE = /* glsl */ `
  {
    vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    float up = dot(normal, upV);
    bool bare = vTree >= 0.4;
    // February in Dallas: live oaks and cedars stay green, the rest are bare grey-brown crowns
    vec3 col = !bare ? mix(vec3(0.16, 0.26, 0.14), vec3(0.25, 0.34, 0.18), fract(vTree * 7.3))
                     : mix(vec3(0.3, 0.26, 0.22), vec3(0.4, 0.35, 0.29), fract(vTree * 5.1));
    if (vTrunk > 0.5) col = vec3(0.24, 0.19, 0.15);
    else {
      // twiggy texture up close: bare crowns are a tangle of grey-brown branches, evergreens are clumpy
      float pxm = fwidth(vTP.x) * uMPU;
      float k = 1.0 - smoothstep(0.1, 0.35, pxm);
      float n = noiseT(vTP * uMPU / (bare ? 0.45 : 0.9)) * 0.6 + noiseT(vTP * uMPU / 0.18) * 0.4;
      col *= mix(1.0, bare ? 0.6 + 0.6 * n : 0.75 + 0.45 * n, k);
    }
    col *= 0.78 + 0.22 * up;
    col = mix(col, vec3(0.9, 0.93, 0.97), uSnow * smoothstep(0.2, 0.8, up) * 0.75 * (1.0 - vTrunk));
    diffuseColor.rgb = col;
  }
`;

type Patch = { vertexHead: string; vertex: string; vary?: string; fragHead?: string; shade?: string };
function patch(mat: THREE.Material, u: Record<string, THREE.IUniform>, p: Patch, key: string): void {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${p.vertexHead}`)
      .replace('#include <begin_vertex>', `${p.vertex}\n${p.vary ?? ''}`);
    if (p.fragHead) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${p.fragHead}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${p.shade}`);
    }
  };
  mat.customProgramCacheKey = () => key;
}

// ---------- base geometry ----------
/** A unit box (walls on faces along x: aPart 0, along z: 1) with a roof: eaves (2) and a ridge (3). */
function rectBase(): THREE.BufferGeometry {
  const pos: number[] = [], part: number[] = [], idx: number[] = [];
  const quad = (pts: number[][], parts: number[]) => {
    const b = pos.length / 3;
    pts.forEach((p, i) => { pos.push(...p); part.push(parts[i]); });
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const tri = (pts: number[][], parts: number[]) => {
    const b = pos.length / 3;
    pts.forEach((p, i) => { pos.push(...p); part.push(parts[i]); });
    idx.push(b, b + 1, b + 2);
  };
  const s = 0.5;
  quad([[-s, 0, s], [s, 0, s], [s, 1, s], [-s, 1, s]], [0, 0, 0, 0]);
  quad([[s, 0, -s], [-s, 0, -s], [-s, 1, -s], [s, 1, -s]], [0, 0, 0, 0]);
  quad([[s, 0, s], [s, 0, -s], [s, 1, -s], [s, 1, s]], [1, 1, 1, 1]);
  quad([[-s, 0, -s], [-s, 0, s], [-s, 1, s], [-s, 1, -s]], [1, 1, 1, 1]);
  // roof: eave corners E1(-,-) E2(+,-) E3(+,+) E4(-,+); ridge ends R1 (x = -1) and R2 (x = +1)
  const E1 = [-s, 1, -s], E2 = [s, 1, -s], E3 = [s, 1, s], E4 = [-s, 1, s], R1 = [-1, 1, 0], R2 = [1, 1, 0];
  quad([E4, E3, R2, R1], [2, 2, 3, 3]);
  quad([E2, E1, R1, R2], [2, 2, 3, 3]);
  tri([E3, E2, R2], [2, 2, 3]);
  tri([E1, E4, R1], [2, 2, 3]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

/** A crown (icosphere) on a trunk; aTrunk marks the trunk. */
function treeBase(detail: number): THREE.BufferGeometry {
  const crown = new THREE.IcosahedronGeometry(1, detail); // already one vertex per corner
  const trunk = new THREE.CylinderGeometry(1, 1.2, 1, 5, 1, true).translate(0, 0.5, 0).toNonIndexed();
  const pos = [...crown.getAttribute('position').array, ...trunk.getAttribute('position').array];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTrunk', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(0).fill(1, crown.getAttribute('position').count), 1));
  return g;
}

/** Three unit boxes (y 0..1) for rooftop extras; aBox says which. */
function extraBase(): THREE.BufferGeometry {
  const pos: number[] = [], which: number[] = [];
  for (let k = 0; k < 3; k++) {
    const b = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0).toNonIndexed();
    const p = b.getAttribute('position').array;
    pos.push(...p);
    for (let i = 0; i < p.length / 3; i++) which.push(k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBox', new THREE.Float32BufferAttribute(which, 1));
  return g;
}

/** Ground footprint of a box record, for painting and for finding a landmark's outline. */
export function rectCorners(r: Uint16Array, i: number, w: number, h: number, mpu: number): [number, number][] {
  const o = i * 8;
  const x = (r[o] / 65535) * w, z = (r[o + 1] / 65535) * h, a = (r[o + 2] / 65535) * Math.PI;
  const hw = (r[o + 3] * 0.05) / mpu, hd = (r[o + 4] * 0.05) / mpu;
  const ca = Math.cos(a), sa = Math.sin(a);
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [x + u * ca - v * sa, z + u * sa + v * ca]);
}

export class BuildingsLayer {
  readonly group = new THREE.Group();
  readonly uniforms: Record<string, THREE.IUniform>;
  private smallU: Record<string, THREE.IUniform>;
  private treeU: Record<string, THREE.IUniform>;
  private small: THREE.Mesh[] = [];
  private bigs: THREE.Mesh[] = [];
  private trees: THREE.Mesh[] = []; // far: 20-triangle crowns
  private treesNear: THREE.Mesh[] = []; // near: 80-triangle crowns
  private extras: THREE.Mesh[] = []; // chimneys, rooftop AC units, stair penthouses
  private shadowsOn = true;
  /** Houses per circuit (indices into the box records), for smoke and thought bubbles. */
  readonly housesBy: number[][];
  readonly reach: number[];

  constructor(
    private d: BuildingData,
    world: { w: number; h: number },
    centers: [number, number][],
    snow: boolean,
  ) {
    const mpu = d.index.metersPerUnit;
    d.w = world.w; d.h = world.h;
    const pal = paletteTexture();
    // how far each neighborhood's buildings reach from its feed point (the wave's length)
    const reach = new Float32Array(MAX_CIRCUITS);
    this.housesBy = centers.map(() => []);
    const r = d.rects;
    for (let i = 0; i < d.index.rects.count; i++) {
      const o = i * 8, k = r[o + 7];
      if (k >= centers.length) continue;
      const x = (r[o] / 65535) * world.w, z = (r[o + 1] / 65535) * world.h;
      reach[k] = Math.max(reach[k], Math.hypot(x - centers[k][0], z - centers[k][1]));
      if ((r[o + 6] & 7) === KIND.HOUSE) this.housesBy[k].push(i);
    }
    this.reach = Array.from(reach.slice(0, centers.length));
    const centerArr = Array.from({ length: MAX_CIRCUITS }, (_, k) => new THREE.Vector2(...(centers[k] ?? [0, 0])));
    const shared = {
      uFrom: { value: new Float32Array(MAX_CIRCUITS).fill(1) },
      uTo: { value: new Float32Array(MAX_CIRCUITS).fill(1) },
      uT0: { value: new Float32Array(MAX_CIRCUITS).fill(-100) },
      uCenter: { value: centerArr },
      uReach: { value: reach },
      uTime: { value: 0 },
      uNight: { value: 0 },
      uBright: { value: 2.2 },
      uSnow: { value: snow ? 1 : 0 },
      uWorld: { value: new THREE.Vector2(world.w, world.h) },
      uMPU: { value: mpu },
      uVex: { value: VEX },
      uPal: { value: pal },
    };
    this.uniforms = { ...shared, uGrow: { value: 1 } };
    this.smallU = { ...shared, uGrow: { value: 1 } };
    this.treeU = { uWorld: shared.uWorld, uMPU: shared.uMPU, uVex: shared.uVex, uSnow: shared.uSnow, uGrow: { value: 1 } };

    const rectHead = `${LIGHT_GLSL}\nattribute vec4 iA;\nattribute vec4 iB;\nattribute float aPart;`;
    const polyHead = `${LIGHT_GLSL}\nattribute vec4 aInfo;\nattribute float aU;\nattribute float aTop;`;
    const treeHead = `uniform vec2 uWorld; uniform float uMPU; uniform float uVex; uniform float uGrow;\nattribute vec3 iT;\nattribute float aTrunk;\nvarying float vTree;\nvarying float vTrunk;\nvarying vec3 vTP;`;
    const extraHead = `uniform vec2 uWorld; uniform float uMPU; uniform float uVex; uniform float uGrow;\nattribute vec4 iA;\nattribute vec4 iB;\nattribute float aBox;\nvarying vec3 vExtra;\nfloat seedOf(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`;
    const mats = (u: Record<string, THREE.IUniform>, head: string, vtx: string, vary: string, key: string, side: THREE.Side = THREE.FrontSide) => {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, side });
      patch(mat, u, { vertexHead: head, vertex: vtx, vary, fragHead: BUILDING_FRAG, shade: BUILDING_SHADE }, key);
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      patch(depth, u, { vertexHead: head, vertex: vtx }, `${key}-depth`);
      return [mat, depth] as const;
    };
    const [rectBig, rectBigD] = mats(this.uniforms, rectHead, RECT_VERTEX, RECT_VARY, 'b-rect');
    const [rectSmall, rectSmallD] = mats(this.smallU, rectHead, RECT_VERTEX, RECT_VARY, 'b-rect-s');
    // outlines are drawn two-sided: their walls rise a metre past the roof as a parapet, seen from inside too
    const [polyBig, polyBigD] = mats(this.uniforms, polyHead, POLY_VERTEX, POLY_VARY, 'b-poly', THREE.DoubleSide);
    const [polySmall, polySmallD] = mats(this.smallU, polyHead, POLY_VERTEX, POLY_VARY, 'b-poly-s', THREE.DoubleSide);
    const eMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    patch(eMat, this.smallU, { vertexHead: extraHead, vertex: EXTRA_VERTEX, fragHead: EXTRA_FRAG, shade: EXTRA_SHADE }, 'b-extra');
    const eDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patch(eDepth, this.smallU, { vertexHead: extraHead, vertex: EXTRA_VERTEX }, 'b-extra-depth');
    const eBase = extraBase();

    const base = rectBase();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, depth: THREE.Material, c: { big: number; box: number[]; hMax: number }) => {
      const [x0, z0, x1, z1] = c.box;
      const hy = (c.hMax * VEX) / mpu;
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, hy / 2, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0, hy) / 2 + 0.05);
      geo.boundingBox = new THREE.Box3(new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, hy, z1));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.customDepthMaterial = depth;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      (c.big ? this.bigs : this.small).push(mesh);
      this.group.add(mesh);
    };
    for (const c of d.index.rects.chunks) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = base.index;
      geo.setAttribute('position', base.getAttribute('position'));
      geo.setAttribute('aPart', base.getAttribute('aPart'));
      const ib = new THREE.InstancedInterleavedBuffer(r.subarray(c.start * 8, (c.start + c.count) * 8), 8, 1);
      geo.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0, false));
      geo.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4, false));
      geo.instanceCount = c.count;
      add(geo, c.big ? rectBig : rectSmall, c.big ? rectBigD : rectSmallD, c);
      // rooftop extras from the same records
      const eg = new THREE.InstancedBufferGeometry();
      eg.setAttribute('position', eBase.getAttribute('position'));
      eg.setAttribute('aBox', eBase.getAttribute('aBox'));
      eg.setAttribute('iA', geo.getAttribute('iA'));
      eg.setAttribute('iB', geo.getAttribute('iB'));
      eg.instanceCount = c.count;
      eg.boundingSphere = geo.boundingSphere;
      const em = new THREE.Mesh(eg, eMat);
      em.customDepthMaterial = eDepth;
      em.castShadow = em.receiveShadow = true;
      em.matrixAutoUpdate = false;
      em.visible = false;
      this.extras.push(em);
      this.group.add(em);
    }
    for (const c of d.index.polys.chunks) {
      const geo = this.polyGeometry(c.off, c.len, world, mpu);
      if (geo) add(geo, c.big ? polyBig : polySmall, c.big ? polyBigD : polySmallD, c);
    }

    // trees
    const tMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    patch(tMat, this.treeU, {
      vertexHead: treeHead, vertex: TREE_VERTEX, vary: 'vTree = fract(sin(dot(vec2(tx, tz), vec2(12.9898, 78.233))) * 43758.5453); vTrunk = aTrunk; vTP = transformed;',
      fragHead: TREE_FRAG, shade: TREE_SHADE,
    }, 'tree');
    const tDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patch(tDepth, this.treeU, { vertexHead: treeHead, vertex: TREE_VERTEX }, 'tree-depth');
    const bases = [treeBase(0), treeBase(1)];
    for (const c of d.index.trees.chunks) {
      const attr = new THREE.InstancedBufferAttribute(d.trees.subarray(c.start * 3, (c.start + c.count) * 3), 3, false);
      const [x0, z0, x1, z1] = c.box;
      bases.forEach((tb, near) => {
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = tb.index;
        geo.setAttribute('position', tb.getAttribute('position'));
        geo.setAttribute('aTrunk', tb.getAttribute('aTrunk'));
        geo.setAttribute('iT', attr);
        geo.instanceCount = c.count;
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, 0.02, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0) / 2 + 0.05);
        const mesh = new THREE.Mesh(geo, tMat);
        mesh.customDepthMaterial = tDepth;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        (near ? this.treesNear : this.trees).push(mesh);
        this.group.add(mesh);
      });
    }
  }

  /** Real outlines, extruded: walls carry their distance along the outline (for windows), roofs are flat. */
  private polyGeometry(off: number, len: number, world: { w: number; h: number }, mpu: number): THREE.BufferGeometry | null {
    const p = this.d.polys;
    const pos: number[] = [], us: number[] = [], tops: number[] = [], info: number[] = [], idx: number[] = [];
    let o = off;
    const end = off + len;
    while (o < end) {
      const nr = p[o], hM = p[o + 1] * 0.1, style = p[o + 2], circ = p[o + 3];
      o += 4;
      const hy = (hM * VEX) / mpu;
      const py = hy + (1.0 * VEX) / mpu; // walls run a metre past the roof: the parapet
      const kind = style & 7, variant = style >> 5;
      const rings: THREE.Vector2[][] = [];
      for (let r = 0; r < nr; r++) {
        const n = p[o++];
        const ring: THREE.Vector2[] = [];
        for (let j = 0; j < n; j++, o += 2) ring.push(new THREE.Vector2((p[o] / 65535) * world.w, (p[o + 1] / 65535) * world.h));
        rings.push(ring);
      }
      if (!rings.length || rings[0].length < 3) continue;
      const seedB = Math.floor(((Math.sin(rings[0][0].x * 12.9898 + rings[0][0].y * 78.233) * 43758.5453) % 1 + 1) % 1 * 255);
      const push = (x: number, y: number, z: number, u: number) => { pos.push(x, y, z); us.push(u); tops.push(hM); info.push(kind, variant, circ, seedB); return pos.length / 3 - 1; };
      // outer ring clockwise in (x, z) so walls face out (see rectBase), holes the other way
      const signed = (ring: THREE.Vector2[]) => { let s = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j].x * ring[i].y - ring[i].x * ring[j].y; return s; };
      rings.forEach((ring, ri) => {
        const s = signed(ring);
        if ((ri === 0) === s > 0) ring.reverse();
      });
      for (const ring of rings) {
        let u = 0;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          const l = a.distanceTo(b) * mpu;
          const v0 = push(a.x, 0, a.y, u), v1 = push(b.x, 0, b.y, u + l), v2 = push(b.x, py, b.y, u + l), v3 = push(a.x, py, a.y, u);
          idx.push(v0, v1, v2, v0, v2, v3);
          u += l;
        }
      }
      const outer = rings[0], holes = rings.slice(1);
      const tris = THREE.ShapeUtils.triangulateShape(outer, holes);
      const all = outer.concat(...holes);
      const base = pos.length / 3;
      for (const v of all) push(v.x, hy, v.y, -1);
      for (const [a, b, c] of tris) {
        const A = all[a], B = all[b], C = all[c];
        const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
        if (cross < 0) idx.push(base + a, base + b, base + c);
        else idx.push(base + a, base + c, base + b);
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aU', new THREE.Float32BufferAttribute(us, 1));
    g.setAttribute('aTop', new THREE.Float32BufferAttribute(tops, 1));
    g.setAttribute('aInfo', new THREE.BufferAttribute(new Uint8Array(info), 4, false));
    g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    return g;
  }

  /** Called when a neighborhood's power changes: the lights ripple out from its feed point. */
  setLit(k: number, on: boolean, nowSec: number): void {
    const u = this.uniforms;
    const from = u.uFrom.value as Float32Array, to = u.uTo.value as Float32Array, t0 = u.uT0.value as Float32Array;
    from[k] = this.litAt(k, 0.5, nowSec);
    to[k] = on ? 1 : 0;
    t0[k] = nowSec;
  }

  /** JS twin of the shader's litAt, for continuing a wave that's mid-sweep. */
  litAt(k: number, delay: number, t: number): number {
    const u = this.uniforms;
    const from = (u.uFrom.value as Float32Array)[k], to = (u.uTo.value as Float32Array)[k];
    const t0 = (u.uT0.value as Float32Array)[k] + delay * WAVE;
    if (t < t0) return from;
    const p = (t - t0) / 0.3;
    if (p >= 1) return to;
    const seq = to < 0.5 ? [1, 0.2, 0.85, 0.1, 0] : [0, 0.6, 0.15, 0.9, 1];
    return seq[Math.min(4, Math.floor(p * 5))];
  }

  /** Grow houses and trees in as the camera comes close; cast shadows only where they'd show. */
  update(tSec: number, night: number, zoom: number): boolean {
    this.uniforms.uTime.value = tSec;
    this.uniforms.uNight.value = night;
    const gs = THREE.MathUtils.smoothstep(zoom, SMALL_ZOOM, SMALL_ZOOM * 1.5);
    const gt = THREE.MathUtils.smoothstep(zoom, TREE_ZOOM, TREE_ZOOM * 1.5);
    this.smallU.uGrow.value = gs;
    this.treeU.uGrow.value = gt;
    for (const m of this.small) m.visible = gs > 0.001;
    const round = zoom >= 30; // rounder crowns only at street level
    for (const m of this.trees) m.visible = gt > 0.001 && !round;
    for (const m of this.treesNear) m.visible = round;
    for (const m of this.extras) m.visible = zoom >= 40; // a few pixels across from here
    const shadows = zoom >= 9; // below this the shadow map is coarser than a house
    if (shadows === this.shadowsOn) return false;
    this.shadowsOn = shadows;
    for (const m of this.small) m.castShadow = shadows;
    for (const m of [...this.trees, ...this.treesNear]) m.castShadow = shadows;
    return true;
  }

  /** World position and roof height of a box record. */
  rectAt(i: number): { x: number; z: number; top: number } {
    const r = this.d.rects, o = i * 8, mpu = this.d.index.metersPerUnit;
    return { x: (r[o] / 65535) * this.d.w, z: (r[o + 1] / 65535) * this.d.h, top: (r[o + 5] * 0.1 * VEX) / mpu };
  }

  /** The tallest building within `radius` of a point: its outline and height (for landmark trims). */
  outlineNear(x: number, z: number, radius: number): { ring: [number, number][]; top: number } | null {
    const mpu = this.d.index.metersPerUnit, r = this.d.rects, p = this.d.polys;
    let best: { ring: [number, number][]; top: number } | null = null;
    for (let i = 0; i < this.d.index.rects.count; i++) {
      const o = i * 8;
      const bx = (r[o] / 65535) * this.d.w, bz = (r[o + 1] / 65535) * this.d.h;
      if (Math.abs(bx - x) > radius || Math.abs(bz - z) > radius) continue;
      const top = (r[o + 5] * 0.1 * VEX) / mpu;
      if (!best || top > best.top) best = { ring: rectCorners(r, i, this.d.w, this.d.h, mpu), top };
    }
    let o = 0;
    while (o < p.length) {
      const nr = p[o], top = (p[o + 1] * 0.1 * VEX) / mpu;
      o += 4;
      for (let k = 0; k < nr; k++) {
        const n = p[o++];
        if (k === 0) {
          const ring: [number, number][] = [];
          for (let j = 0; j < n; j++) ring.push([(p[o + j * 2] / 65535) * this.d.w, (p[o + j * 2 + 1] / 65535) * this.d.h]);
          const cx = ring.reduce((s, q) => s + q[0], 0) / n, cz = ring.reduce((s, q) => s + q[1], 0) / n;
          if (Math.abs(cx - x) < radius && Math.abs(cz - z) < radius && (!best || top > best.top)) best = { ring, top };
        }
        o += n * 2;
      }
    }
    return best;
  }
}
