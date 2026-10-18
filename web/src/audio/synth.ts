// Every sound in the game, synthesized with the Web Audio API: no audio files, nothing fetched.
// The recipes take any BaseAudioContext, so they can also be rendered offline to check levels.
// House style: soft and warm. Short linear attacks (no clicks), exponential decays, low-passed noise,
// peaks well under full scale, and a gentle compressor on the master bus to glue it all together.

type Kind = 'sine' | 'triangle' | 'sawtooth' | 'square';

interface ToneOpts {
  type?: Kind;
  freq: number;
  /** glide exponentially to this frequency over `glide` seconds */
  to?: number;
  glide?: number;
  detune?: number;
  peak: number;
  attack?: number;
  hold?: number;
  /** seconds from peak to about -50 dB */
  decay: number;
  lowpass?: number;
  /** sweep the lowpass to this cutoff over the glide */
  lpTo?: number;
  pan?: number;
}

interface NoiseOpts {
  type: BiquadFilterType;
  freq: number;
  to?: number;
  glide?: number;
  q?: number;
  peak: number;
  attack?: number;
  hold?: number;
  decay: number;
  pan?: number;
}

export type PingKind = 'cold' | 'bright' | 'neutral';

/** Hold an automated param where it is right now, then ease it toward `v` (time constant `tc`). */
export function glide(p: AudioParam, v: number, t: number, tc: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
  else {
    const cur = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(cur, t);
  }
  p.setTargetAtTime(v, t, tc);
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** Linear attack from silence, optional hold, then an exponential fall. Returns when it is inaudible. */
function envelope(p: AudioParam, t: number, peak: number, attack: number, hold: number, decay: number): number {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) p.setValueAtTime(peak, t + attack + hold);
  p.setTargetAtTime(0, t + attack + hold, decay / 6);
  return t + attack + hold + decay * 1.2;
}

/** Stereo pink noise with a seamless loop point (the tail is cross-faded into the head). */
function pinkNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const xf = Math.floor(sr * 0.3);
  const buf = ctx.createBuffer(2, n, sr);
  const raw = new Float32Array(n + xf);
  for (let ch = 0; ch < 2; ch++) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = raw[i];
    for (let i = 0; i < xf; i++) {
      const a = (i / xf) * (Math.PI / 2);
      d[i] = raw[i] * Math.sin(a) + raw[n + i] * Math.cos(a);
    }
  }
  return buf;
}

// Warm pairs for the restore chime (root, fifth), all inside C major pentatonic.
const CHIMES: [number, number][] = [[392, 587.33], [440, 659.25], [523.25, 783.99]];
const TOOL_PITCH: Record<string, number> = { inspect: 523.25, cut: 392, restore: 587.33, emergency: 440, buy: 493.88 };

export class Synth {
  readonly ctx: BaseAudioContext;
  readonly out: AudioNode;
  readonly noiseBuf: AudioBuffer;
  private lastChime = -1;

  constructor(ctx: BaseAudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = out;
    this.noiseBuf = pinkNoise(ctx, 6);
  }

  /** A start time a hair ahead of now, so no attack is ever clipped. */
  at(delay = 0): number {
    return this.ctx.currentTime + 0.015 + delay;
  }

  private finish(src: AudioScheduledSourceNode, nodes: AudioNode[], end: number): void {
    src.stop(end);
    src.onended = () => {
      src.disconnect();
      for (const n of nodes) n.disconnect();
    };
  }

  private tail(first: AudioNode, nodes: AudioNode[], lowpass: number | undefined, pan: number | undefined, sweep?: [number, number, number]): void {
    let n = first;
    if (lowpass) {
      const f = biquad(this.ctx, 'lowpass', lowpass, 0.5);
      if (sweep) { f.frequency.setValueAtTime(lowpass, sweep[0]); f.frequency.exponentialRampToValueAtTime(sweep[1], sweep[0] + sweep[2]); }
      nodes.push(f); n.connect(f); n = f;
    }
    if (pan) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; nodes.push(p); n.connect(p); n = p; }
    n.connect(this.out);
  }

  tone(t: number, o: ToneOpts): void {
    const { ctx } = this;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide ?? o.decay));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const end = envelope(g.gain, t, o.peak, o.attack ?? 0.005, o.hold ?? 0, o.decay);
    osc.connect(g);
    const nodes: AudioNode[] = [g];
    this.tail(g, nodes, o.lowpass, o.pan, o.lpTo ? [t, o.lpTo, o.glide ?? o.decay] : undefined);
    osc.start(t);
    this.finish(osc, nodes, end);
  }

  noise(t: number, o: NoiseOpts): void {
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const g = ctx.createGain();
    // fold the stereo noise to mono so one-shots sit in the middle
    g.channelCount = 1;
    g.channelCountMode = 'explicit';
    const end = envelope(g.gain, t, o.peak, o.attack ?? 0.004, o.hold ?? 0, o.decay);
    const f = biquad(ctx, o.type, o.freq, o.q ?? 0.7);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide ?? o.decay));
    src.connect(g).connect(f);
    const nodes: AudioNode[] = [g, f];
    this.tail(f, nodes, undefined, o.pan);
    src.start(t, Math.random() * (this.noiseBuf.duration - 1));
    this.finish(src, nodes, end);
  }

  // ---------------------------------------------------------------- UI

  /** A soft wooden "tok" for HUD buttons. */
  tick(t: number): void {
    const f = 880 * (0.96 + Math.random() * 0.08);
    this.tone(t, { type: 'triangle', freq: f, to: f * 0.6, glide: 0.05, peak: 0.07, attack: 0.002, decay: 0.08, lowpass: 2400 });
    this.tone(t, { freq: f * 0.5, to: f * 0.34, glide: 0.04, peak: 0.05, attack: 0.002, decay: 0.06 });
  }

  /** A little rounded "bloop": rising when a tool is picked up, falling when it is put away. */
  select(tool: string, delay = 0): void {
    const t = this.at(delay);
    const base = TOOL_PITCH[tool] ?? 523.25;
    const up = tool !== 'inspect';
    const f0 = up ? base : base * 1.26, f1 = up ? base * 1.5 : base;
    this.tone(t, { freq: f0, to: f1, glide: 0.07, peak: 0.09, attack: 0.006, decay: 0.24, lowpass: 3000 });
    this.tone(t, { type: 'triangle', freq: f0 * 2, to: f1 * 2, glide: 0.07, peak: 0.014, attack: 0.006, decay: 0.12, lowpass: 3000 });
  }

  // ---------------------------------------------------------------- grid

  /** A heavy relay clunk, then the neighborhood's hum winding down (120 → 40 Hz). */
  cut(t: number, count = 1): void {
    const heavy = Math.min(1.2, 1 + 0.08 * (count - 1));
    this.noise(t, { type: 'bandpass', freq: 1500, q: 1.3, peak: 0.05, attack: 0.0015, decay: 0.03 });
    this.noise(t + 0.004, { type: 'lowpass', freq: 620, q: 1.1, peak: 0.34 * heavy, attack: 0.003, decay: 0.12 });
    this.tone(t + 0.004, { freq: 140, to: 46, glide: 0.12, peak: 0.36 * heavy, attack: 0.004, decay: 0.26 });
    const h = t + 0.05;
    this.tone(h, { type: 'triangle', freq: 120, to: 40, glide: 0.6, peak: 0.12, attack: 0.03, hold: 0.1, decay: 0.55, lowpass: 900 });
    // a lowpassed saw gives the hum enough harmonics to be heard on laptop speakers; its filter closes as it dies
    this.tone(h, { type: 'sawtooth', freq: 120, to: 40, glide: 0.6, peak: 0.05, attack: 0.03, hold: 0.08, decay: 0.5, lowpass: 700, lpTo: 240 });
  }

  /** A lighter relay click, a hum rising back up, and a warm two-note chime. */
  restore(t: number): void {
    this.noise(t, { type: 'bandpass', freq: 1300, q: 1.2, peak: 0.035, attack: 0.0015, decay: 0.03 });
    this.tone(t, { type: 'triangle', freq: 45, to: 115, glide: 0.42, peak: 0.07, attack: 0.12, hold: 0.1, decay: 0.45, lowpass: 800 });
    this.tone(t, { type: 'sawtooth', freq: 45, to: 115, glide: 0.42, peak: 0.035, attack: 0.12, hold: 0.06, decay: 0.38, lowpass: 280, lpTo: 760 });
    let i = Math.floor(Math.random() * CHIMES.length);
    if (i === this.lastChime) i = (i + 1) % CHIMES.length;
    this.lastChime = i;
    const [a, b] = CHIMES[i];
    this.chime(t + 0.06, a, 0.066, 0.9);
    this.chime(t + 0.19, b, 0.062, 1.2);
  }

  private chime(t: number, f: number, peak: number, decay: number): void {
    this.tone(t, { freq: f, peak, attack: 0.006, decay });
    this.tone(t, { type: 'triangle', freq: f, detune: 7, peak: peak * 0.35, attack: 0.006, decay: decay * 0.6, lowpass: 3200 });
    this.tone(t, { freq: f * 2, peak: peak * 0.12, attack: 0.004, decay: decay * 0.35 });
  }

  // ---------------------------------------------------------------- news

  /** Something placed on the map: a soft wooden thunk under a two-note sparkle. */
  place(t: number): void {
    this.tone(t, { freq: 190, to: 95, glide: 0.09, peak: 0.22, attack: 0.003, decay: 0.16 });
    this.noise(t, { type: 'lowpass', freq: 900, q: 0.8, peak: 0.12, attack: 0.002, decay: 0.06 });
    this.chime(t + 0.06, 1046.5, 0.05, 0.5);
    this.chime(t + 0.14, 1568, 0.045, 0.7);
  }

  /** A line repaired: two ratchet clicks of a wrench, then a rising chime. */
  repair(t: number): void {
    for (let i = 0; i < 3; i++) this.noise(t + i * 0.07, { type: 'bandpass', freq: 3200, q: 7, peak: 0.09, attack: 0.001, decay: 0.035 });
    this.tone(t + 0.22, { type: 'triangle', freq: 220, peak: 0.08, attack: 0.002, decay: 0.12, lowpass: 1600 });
    this.chime(t + 0.3, 659.25, 0.06, 0.8);
    this.chime(t + 0.42, 987.77, 0.055, 1.1);
  }

  /** The grid operator's order: a radio-dispatch two-tone (three notes when cuts begin), clearly over the wind. */
  order(t: number, first: boolean): void {
    const notes = first ? [880, 659.25, 880] : [880, 659.25];
    notes.forEach((f, i) => {
      const at = t + i * 0.17;
      this.tone(at, { type: 'square', freq: f, peak: 0.045, attack: 0.004, hold: 0.08, decay: 0.09, lowpass: 2400 });
      this.tone(at, { freq: f, peak: 0.07, attack: 0.004, hold: 0.08, decay: 0.12 });
    });
  }

  /** A soft rising two-tone bell for a new decision card. */
  bell(t: number): void {
    this.bellNote(t, 523.25, 0.085);
    this.bellNote(t + 0.24, 659.25, 0.08);
  }

  private bellNote(t: number, f: number, peak: number): void {
    this.tone(t, { freq: f, peak, attack: 0.005, decay: 1.6 });
    this.tone(t, { freq: f * 2, peak: peak * 0.28, attack: 0.004, decay: 0.7 });
    this.tone(t, { freq: f * 2.76, peak: peak * 0.08, attack: 0.003, decay: 0.32 });
  }

  /** One soft ping for a notice: lower and glassy when it is about cold or ice, brighter for good news. */
  ping(t: number, kind: PingKind): void {
    if (kind === 'cold') {
      const f = 523.25;
      this.tone(t, { freq: f, to: f * 0.985, glide: 0.7, peak: 0.1, attack: 0.005, decay: 0.75 });
      this.tone(t, { freq: f * 2, peak: 0.016, attack: 0.004, decay: 0.35 });
      this.tone(t, { freq: f * 4.01, peak: 0.009, attack: 0.003, decay: 0.25 });
    } else if (kind === 'bright') {
      const f = 783.99;
      this.tone(t, { freq: f, peak: 0.084, attack: 0.004, decay: 0.6 });
      this.tone(t, { type: 'triangle', freq: f, detune: 5, peak: 0.03, attack: 0.004, decay: 0.35, lowpass: 4000 });
      this.tone(t, { freq: f * 2, peak: 0.02, attack: 0.003, decay: 0.28 });
    } else {
      const f = 659.25;
      this.tone(t, { freq: f, peak: 0.092, attack: 0.005, decay: 0.6 });
      this.tone(t, { freq: f * 2, peak: 0.016, attack: 0.004, decay: 0.3 });
    }
  }

  // ---------------------------------------------------------------- story beats

  /** The storm arrives: a low swell under a wind gust that crosses the room. */
  stormArrives(t: number): void {
    const { ctx } = this;
    const lp = biquad(ctx, 'lowpass', 160, 0.7);
    lp.frequency.setValueAtTime(160, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + 1.4);
    lp.frequency.exponentialRampToValueAtTime(220, t + 3.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.2, t + 1.4);
    g.gain.setTargetAtTime(0, t + 1.5, 0.7);
    const end = t + 5.8;
    lp.connect(g).connect(this.out);
    const voices: [Kind, number, number, number][] = [
      ['triangle', 55, -5, 0.5], ['triangle', 82.41, 4, 0.42], ['sine', 110, 2, 0.4], ['triangle', 164.81, -3, 0.16],
    ];
    voices.forEach(([type, f, detune, level], i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      const v = ctx.createGain();
      v.gain.value = level;
      o.connect(v).connect(lp);
      o.start(t);
      o.stop(end);
      o.onended = () => {
        o.disconnect();
        v.disconnect();
        if (i === 0) { lp.disconnect(); g.disconnect(); }
      };
    });
    // the gust: band-passed noise that rises, whistles and sweeps left to right
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.gain.setValueAtTime(0, t);
    mono.gain.linearRampToValueAtTime(0.24, t + 1.2);
    mono.gain.setTargetAtTime(0, t + 1.35, 0.7);
    const bp = biquad(ctx, 'bandpass', 260, 1.1);
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(1000, t + 1.3);
    bp.frequency.exponentialRampToValueAtTime(380, t + 3.6);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(-0.5, t);
    pan.pan.linearRampToValueAtTime(0.5, t + 3.2);
    src.connect(mono).connect(bp).connect(pan).connect(this.out);
    src.start(t, Math.random() * 3);
    this.finish(src, [mono, bp, pan], end);
  }

  /** The storm is over: a gently rolled C major add-nine chord. */
  resolve(t: number): void {
    const notes = [130.81, 196, 329.63, 392, 587.33];
    notes.forEach((f, i) => {
      const s = t + i * 0.09;
      this.tone(s, { freq: f, peak: 0.05, attack: 0.04, decay: 4 });
      this.tone(s, { type: 'triangle', freq: f, detune: i % 2 ? 5 : -5, peak: 0.016, attack: 0.05, decay: 3, lowpass: 2000 });
    });
    this.tone(t + 0.55, { freq: 659.25, peak: 0.03, attack: 0.02, decay: 2.5 });
  }
}

// ------------------------------------------------------------------ ambience

export interface WindMood {
  /** 0–1 loudness, before WIND_GAIN */
  level: number;
  /** center of the whistling band, Hz */
  center: number;
  /** how far the slow gusts swing the band, Hz */
  depth: number;
  /** low rumble amount */
  rumble: number;
}

/** Calibration from offline renders: mood level 1 sits around -30 dBFS RMS at the speakers. */
export const WIND_GAIN = 0.16;

/** A looping wind bed: low rumble plus a band-passed gusty layer, both swung by slow LFOs. */
export class Wind {
  private readonly ctx: BaseAudioContext;
  private readonly level: GainNode;
  private readonly bp: BiquadFilterNode;
  private readonly rumble: GainNode;
  private readonly depthA: GainNode;
  private readonly depthB: GainNode;
  private readonly gustAmt: ConstantSourceNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];

  constructor(ctx: BaseAudioContext, noise: AudioBuffer, dest: AudioNode) {
    this.ctx = ctx;
    const keep = <T extends AudioNode>(n: T): T => { this.nodes.push(n); return n; };
    const gain = (v: number) => { const g = keep(ctx.createGain()); g.gain.value = v; return g; };
    const loop = (offset: number) => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.start(0, offset);
      this.sources.push(s);
      return s;
    };
    const lfo = (hz: number) => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      o.start();
      this.sources.push(o);
      return o;
    };

    this.level = gain(0);
    const cabin = keep(biquad(ctx, 'lowpass', 2000, 0.5)); // heard from inside the control room
    cabin.connect(this.level).connect(dest);

    // low rumble
    this.rumble = gain(0.5);
    loop(0).connect(keep(biquad(ctx, 'lowpass', 260, 0.5))).connect(this.rumble).connect(cabin);

    // the gusty, whistling layer
    this.bp = keep(biquad(ctx, 'bandpass', 500, 0.85));
    const body = gain(0.6);
    loop(noise.duration * 0.47).connect(this.bp).connect(keep(biquad(ctx, 'lowpass', 1500, 0.4))).connect(body).connect(cabin);

    // slow LFOs at unrelated rates, so the gusts never fall into a pattern
    const a = lfo(0.067), b = lfo(0.109), c = lfo(0.041);
    this.depthA = gain(160);
    this.depthB = gain(80);
    a.connect(this.depthA).connect(this.bp.frequency);
    b.connect(this.depthB).connect(this.bp.frequency);
    b.connect(gain(0.22)).connect(body.gain); // louder as it whistles higher, like a real gust
    c.connect(gain(0.26)).connect(body.gain);
    a.connect(gain(0.12)).connect(this.rumble.gain);

    // one-off gusts on top of the LFOs
    this.gustAmt = ctx.createConstantSource();
    this.gustAmt.offset.value = 0;
    this.gustAmt.start();
    this.sources.push(this.gustAmt);
    this.gustAmt.connect(gain(380)).connect(this.bp.frequency);
    this.gustAmt.connect(gain(0.55)).connect(body.gain);
  }

  set(m: WindMood, tc: number): void {
    const t = this.ctx.currentTime;
    glide(this.level.gain, m.level * WIND_GAIN, t, tc);
    glide(this.bp.frequency, m.center, t, tc);
    glide(this.depthA.gain, m.depth, t, tc);
    glide(this.depthB.gain, m.depth * 0.5, t, tc);
    glide(this.rumble.gain, m.rumble, t, tc);
  }

  /** A single gust, 0–1. */
  gust(strength: number): void {
    const t = this.ctx.currentTime;
    const rise = 0.5 + Math.random() * 0.5, hold = 0.6 + Math.random() * 1.4;
    const p = this.gustAmt.offset;
    glide(p, strength, t, rise / 3);
    p.setTargetAtTime(0, t + rise + hold, 0.9 + Math.random() * 0.7);
  }

  dispose(): void {
    for (const s of this.sources) {
      try { s.stop(); } catch { /* already stopped */ }
      s.disconnect();
    }
    for (const n of this.nodes) n.disconnect();
  }
}

// ------------------------------------------------------------------ master bus

export interface MasterBus {
  /** everything plays into this */
  input: GainNode;
  /** the master volume after the compressor; mute ramps this to 0 */
  volume: GainNode;
  dispose(): void;
}

export function createMasterBus(ctx: BaseAudioContext, dest: AudioNode, volume: number): MasterBus {
  const input = ctx.createGain();
  const warm = biquad(ctx, 'lowpass', 9000, 0.5); // take the edge off everything
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  const vol = ctx.createGain();
  vol.gain.value = volume;
  input.connect(warm).connect(comp).connect(vol).connect(dest);
  return {
    input,
    volume: vol,
    dispose() {
      for (const n of [input, warm, comp, vol]) n.disconnect();
    },
  };
}
