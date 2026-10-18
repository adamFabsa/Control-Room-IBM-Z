// Paints the county floor from real data into two textures:
// - ground: land use (tract density, airports and runways, parks, campuses), creek green belts, the Trinity
//   floodplain and every street; a clear-day palette and a snow palette
// - lights: the city at night, streets glowing by how built-up they are, for the per-neighborhood emissive map
// From afar the real building footprints are painted in too, so the city has its real grain before the
// 3D buildings grow in.
import * as THREE from 'three';
import type { BuildingData } from './buildings';

type Ring = [number, number][];
export interface GroundData {
  w: number;
  h: number;
  tracts: [number, Ring[][]][];
  landuse: { k: 'air' | 'park' | 'golf' | 'cemetery' | 'campus'; polys: Ring[][]; runways?: [number, number, number, number][] }[];
  lakes: Ring[][];
  rivers: Ring[];
  creeks: Ring[];
  interstates: Ring[];
  highways: Ring[];
  streets: Float32Array; // x, y, z triplets, two per segment
  buildings?: BuildingData;
}

const DAY = {
  base: '#aec58a', urban: '#cdc6b6', park: '#97c272', golf: '#a3d07b', cemetery: '#acc88e', campus: '#d3d6c6',
  air: '#c3c6c6', runway: '#73787f', mark: '#f1f1ea', street: '#8f9396', creek: '#6fa6d3', belt: '#99c174', flood: '#a3c67f',
  shoulder: 'rgba(70, 76, 84, 0.35)',
};
const SNOW = {
  base: '#eef2f7', urban: '#d9dee5', park: '#f3f6fa', golf: '#f1f5f9', cemetery: '#ecf0f5', campus: '#e6eaf0',
  air: '#d6dbe2', runway: '#8f98a4', mark: '#f7f9fb', street: '#97a1ad', creek: '#bccfe0', belt: '#f2f5f9', flood: '#edf1f6',
  shoulder: 'rgba(90, 100, 112, 0.35)',
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** How built-up a tract looks, from people per km². */
export const builtUp = (dens: number) => smooth(250, 3600, dens);

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

/**
 * Three textures: the ground (land, water belts, land use), the streets and building footprints on a layer
 * of their own (`detail`: it carries the city's grain from afar and fades out up close, where the real 3D
 * streets and buildings take over, so the magnified texture never smears around them), and the night lights.
 */
export function paintGround(d: GroundData, snow: boolean, maxAniso: number): { ground: THREE.CanvasTexture; detail: THREE.CanvasTexture; lights: THREE.CanvasTexture } {
  const pal = snow ? SNOW : DAY;
  const S = 4096;
  const [c, g] = canvas(S);
  const kx = S / d.w, kz = S / d.h;
  const polyPath = (ctx: CanvasRenderingContext2D, polys: Ring[][], sx = kx, sz = kz) => {
    ctx.beginPath();
    for (const poly of polys) for (const ring of poly) {
      ring.forEach(([x, z], i) => (i ? ctx.lineTo(x * sx, z * sz) : ctx.moveTo(x * sx, z * sz)));
      ctx.closePath();
    }
  };
  const linePath = (ctx: CanvasRenderingContext2D, lines: Ring[], sx = kx, sz = kz) => {
    ctx.beginPath();
    for (const l of lines) l.forEach(([x, z], i) => (i ? ctx.lineTo(x * sx, z * sz) : ctx.moveTo(x * sx, z * sz)));
  };

  // built-up land from tract density, softened so tract edges don't show
  const D = 1024;
  const [dc, dg] = canvas(D);
  dg.fillStyle = '#000';
  dg.fillRect(0, 0, D, D);
  for (const [dens, polys] of d.tracts) {
    const v = Math.round(builtUp(dens) * 255);
    dg.fillStyle = `rgb(${v},${v},${v})`;
    polyPath(dg, polys, D / d.w, D / d.h);
    dg.fill('evenodd');
  }
  const [mc, mg] = canvas(D); // blurred density mask, reused for the lights
  mg.filter = 'blur(5px)';
  mg.drawImage(dc, 0, 0);
  mg.filter = 'none';

  g.fillStyle = pal.base;
  g.fillRect(0, 0, S, S);
  // urban color through the density mask
  const [uc, ug] = canvas(D);
  ug.fillStyle = pal.urban;
  ug.fillRect(0, 0, D, D);
  ug.globalCompositeOperation = 'destination-in';
  const md = mg.getImageData(0, 0, D, D);
  for (let i = 0; i < md.data.length; i += 4) md.data[i + 3] = md.data[i];
  const [ac, ag] = canvas(D);
  ag.putImageData(md, 0, 0);
  ug.drawImage(ac, 0, 0);
  g.imageSmoothingQuality = 'high';
  g.drawImage(uc, 0, 0, S, S);

  // large soft mottling so open land isn't flat
  const N = 256;
  const [nc, ng] = canvas(N);
  const nd = ng.createImageData(N, N);
  for (let i = 0; i < nd.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 70;
    nd.data[i] = nd.data[i + 1] = nd.data[i + 2] = v;
    nd.data[i + 3] = 255;
  }
  ng.putImageData(nd, 0, 0);
  g.save();
  g.globalAlpha = snow ? 0.1 : 0.22;
  g.globalCompositeOperation = 'overlay';
  g.filter = 'blur(18px)';
  g.drawImage(nc, 0, 0, S, S);
  g.restore();

  // green belts: the Trinity floodplain and the creeks
  g.lineCap = g.lineJoin = 'round';
  g.strokeStyle = pal.flood;
  g.globalAlpha = 0.55;
  g.lineWidth = 1.5 * kx;
  linePath(g, d.rivers);
  g.stroke();
  g.strokeStyle = pal.belt;
  g.globalAlpha = 0.45;
  g.lineWidth = 0.3 * kx;
  linePath(g, d.creeks);
  g.stroke();
  g.globalAlpha = 1;

  // land use
  for (const lu of d.landuse) {
    g.fillStyle = pal[lu.k];
    polyPath(g, lu.polys);
    g.fill('evenodd');
  }
  for (const lu of d.landuse) for (const [ax, az, bx, bz] of lu.runways ?? []) {
    g.strokeStyle = pal.runway;
    g.lineCap = 'butt';
    g.lineWidth = 0.075 * kx;
    g.beginPath(); g.moveTo(ax * kx, az * kz); g.lineTo(bx * kx, bz * kz); g.stroke();
    g.strokeStyle = pal.mark;
    g.lineWidth = 0.008 * kx;
    g.setLineDash([0.06 * kx, 0.05 * kx]);
    g.stroke();
    g.setLineDash([]);
  }

  // the detail layer: every street (plowed slush in the storm) and every building's footprint
  const [dtc, dtg] = canvas(S);
  dtg.lineCap = dtg.lineJoin = 'round';
  dtg.strokeStyle = pal.street;
  dtg.lineWidth = 0.02 * kx;
  dtg.beginPath();
  const st = d.streets;
  for (let i = 0; i < st.length; i += 6) {
    dtg.moveTo(st[i] * kx, st[i + 2] * kz);
    dtg.lineTo(st[i + 3] * kx, st[i + 5] * kz);
  }
  dtg.stroke();
  if (d.buildings) paintFootprints(dtg, d.buildings, d.w, d.h, kx, kz, snow);
  // soft shoulders under the 3D highway ribbons
  g.strokeStyle = pal.shoulder;
  g.lineWidth = 0.16 * kx;
  linePath(g, d.interstates);
  g.stroke();
  g.lineWidth = 0.1 * kx;
  linePath(g, d.highways);
  g.stroke();
  // creeks
  g.strokeStyle = pal.creek;
  g.lineWidth = 0.022 * kx;
  linePath(g, d.creeks);
  g.stroke();

  // ---------- the city at night ----------
  const L = 2048;
  const [lc, lg] = canvas(L);
  const lx = L / d.w, lz = L / d.h;
  lg.fillStyle = '#000';
  lg.fillRect(0, 0, L, L);
  // streetlights as separate pools of light along every street: from afar they blend into a glowing street
  // network, up close they read as lamps rather than lit tubes
  lg.lineCap = lg.lineJoin = 'round';
  lg.strokeStyle = '#ffb35c';
  lg.lineWidth = 0.036 * lx;
  lg.setLineDash([0.001 * lx, 0.085 * lx]);
  lg.beginPath();
  for (let i = 0; i < st.length; i += 6) {
    lg.moveTo(st[i] * lx, st[i + 2] * lz);
    lg.lineTo(st[i + 3] * lx, st[i + 5] * lz);
  }
  lg.stroke();
  lg.setLineDash([]);
  // a faint continuous wash so streets still connect at county scale
  lg.globalAlpha = 0.28;
  lg.lineWidth = 0.02 * lx;
  lg.stroke();
  lg.globalAlpha = 1;
  // dim the streets of open land: multiply by the (lifted) density mask
  lg.globalCompositeOperation = 'multiply';
  const [lm, lmg] = canvas(D);
  lmg.drawImage(mc, 0, 0);
  const ld = lmg.getImageData(0, 0, D, D);
  for (let i = 0; i < ld.data.length; i += 4) {
    const v = 0.22 + 0.78 * (ld.data[i] / 255);
    ld.data[i] = ld.data[i + 1] = ld.data[i + 2] = Math.round(v * 255);
  }
  lmg.putImageData(ld, 0, 0);
  lg.drawImage(lm, 0, 0, L, L);
  lg.globalCompositeOperation = 'source-over';
  lg.filter = 'none';
  // arterials and freeways burn brighter
  lg.strokeStyle = '#ffd08f';
  lg.lineWidth = 0.05 * lx;
  linePath(lg, d.highways, lx, lz);
  lg.stroke();
  lg.lineWidth = 0.07 * lx;
  lg.strokeStyle = '#ffe2b0';
  linePath(lg, d.interstates, lx, lz);
  lg.stroke();
  for (const lu of d.landuse) for (const [ax, az, bx, bz] of lu.runways ?? []) {
    lg.strokeStyle = '#cfe4ff';
    lg.lineWidth = 0.02 * lx;
    lg.setLineDash([0.03 * lx, 0.05 * lx]);
    lg.beginPath(); lg.moveTo(ax * lx, az * lz); lg.lineTo(bx * lx, bz * lz); lg.stroke();
    lg.setLineDash([]);
  }
  // glow
  const [gc, gg] = canvas(L);
  gg.filter = 'blur(6px)';
  gg.drawImage(lc, 0, 0);
  lg.globalCompositeOperation = 'lighter';
  lg.globalAlpha = 0.9;
  lg.drawImage(gc, 0, 0);
  lg.globalAlpha = 1;
  lg.globalCompositeOperation = 'source-over';
  // no light on the water
  lg.fillStyle = '#000';
  polyPath(lg, d.lakes, lx, lz);
  lg.fill('evenodd');

  const tex = (cv: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    return t;
  };
  const detail = tex(dtc);
  detail.premultiplyAlpha = true; // so its mipmaps fade to clear, not to dark
  return { ground: tex(c), detail, lights: tex(lc) };
}

// roof tones seen from above: shingles for houses, membrane and gravel for flat roofs (sRGB)
const ROOF_TONES: [number, number, number][] = [[124, 117, 109], [136, 125, 113], [112, 112, 116], [146, 133, 118], [222, 222, 218], [198, 198, 194], [176, 176, 172], [212, 206, 196]];
const SNOW_TONES: [number, number, number][] = [[198, 205, 214], [208, 214, 221], [188, 196, 206]];
/**
 * Every building's footprint, rasterized into a layer of its own and laid over the ground (canvas paths
 * with 650,000 shapes would take minutes). Most buildings are a pixel or two here, so tiny ones get
 * area-weighted alpha; the large irregular ones are scanline-filled from their real outlines.
 */
function paintFootprints(g: CanvasRenderingContext2D, b: BuildingData, w: number, h: number, kx: number, kz: number, snow: boolean): void {
  const S = g.canvas.width;
  const px = new Uint8ClampedArray(S * S * 4);
  const mpu = b.index.metersPerUnit, r = b.rects;
  const alpha = (snow ? 0.8 : 0.9) * 255;
  const put = (x: number, y: number, c: [number, number, number], a: number) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const o = (y * S + x) * 4;
    if (a <= px[o + 3]) return;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = a;
  };
  for (let i = 0; i < b.index.rects.count; i++) {
    const o = i * 8;
    const kind = r[o + 6] & 7;
    const flat = kind === 2 || kind === 3 || kind === 6;
    const tone = snow ? SNOW_TONES[i % 3] : ROOF_TONES[flat ? 4 + (i % 4) : i % 4];
    const cx = (r[o] / 65535) * w * kx, cy = (r[o + 1] / 65535) * h * kz, an = (r[o + 2] / 65535) * Math.PI;
    const hw = ((r[o + 3] * 0.05) / mpu) * kx, hd = ((r[o + 4] * 0.05) / mpu) * kz;
    const ca = Math.cos(an), sa = Math.sin(an);
    const ex = Math.abs(hw * ca) + Math.abs(hd * sa), ey = Math.abs(hw * sa) + Math.abs(hd * ca);
    if (ex < 1 && ey < 1) { // smaller than a pixel: one pixel, weighted by area
      put(Math.floor(cx), Math.floor(cy), tone, Math.min(1, 4 * hw * hd) * alpha);
      continue;
    }
    const x0 = Math.floor(cx - ex), x1 = Math.ceil(cx + ex), y0 = Math.floor(cy - ey), y1 = Math.ceil(cy + ey);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      if (Math.abs(u) <= hw + 0.35 && Math.abs(v) <= hd + 0.35) put(x, y, tone, alpha);
    }
  }
  // irregular buildings: even-odd scanline fill over all their rings (courtyards stay open)
  const pp = b.polys, tone: [number, number, number] = snow ? [192, 199, 208] : [181, 179, 173];
  const xs: number[] = [];
  for (let o = 0; o < pp.length;) {
    const nr = pp[o];
    o += 4;
    const rings: Float64Array[] = [];
    let y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < nr; k++) {
      const n = pp[o++];
      const ring = new Float64Array(n * 2);
      for (let j = 0; j < n; j++, o += 2) {
        ring[j * 2] = (pp[o] / 65535) * w * kx;
        ring[j * 2 + 1] = (pp[o + 1] / 65535) * h * kz;
        y0 = Math.min(y0, ring[j * 2 + 1]); y1 = Math.max(y1, ring[j * 2 + 1]);
      }
      rings.push(ring);
    }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(S - 1, Math.ceil(y1)); y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (const ring of rings) {
        const n = ring.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const ay = ring[i * 2 + 1], by = ring[j * 2 + 1];
          if (ay > sy !== by > sy) xs.push(ring[i * 2] + ((sy - ay) * (ring[j * 2] - ring[i * 2])) / (by - ay));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.round(xs[k])); x < Math.min(S, Math.round(xs[k + 1])); x++) put(x, y, tone, alpha);
    }
  }
  const [lc, lg] = canvas(S);
  lg.putImageData(new ImageData(px, S, S), 0, 0);
  g.drawImage(lc, 0, 0);
}

/** UVs for flat XZ geometry so it samples the county textures by world position. */
export function worldUV(geo: THREE.BufferGeometry, w: number, h: number): void {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / w;
    uv[i * 2 + 1] = 1 - pos.getZ(i) / h;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
