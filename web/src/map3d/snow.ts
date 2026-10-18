// Falling snow drawn in screen space: soft round flakes in depth layers (small and slow far away,
// big and blurred up close), drifting on a gusting wind. All motion runs in the vertex shader.
import * as THREE from 'three';

export class Snowfall {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(count: number) {
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const depth = Math.random() ** 1.8; // most flakes far away
      seeds.set([Math.random(), Math.random(), depth, Math.random()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uWind: { value: 0.5 },
        uAmount: { value: 0.7 },
        uScale: { value: 1 },
        uAspect: { value: 1 },
        uPan: { value: new THREE.Vector2() },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime, uWind, uAmount, uScale, uAspect;
        uniform vec2 uPan;
        varying float vA;
        varying float vSoft;
        void main() {
          float d = aSeed.z;
          float fall = mix(0.035, 0.16, d);
          float y = fract(aSeed.y - uTime * fall + uPan.y * mix(0.15, 0.9, d));
          float sway = sin(uTime * (0.7 + d) + aSeed.w * 6.283) * 0.012 * (0.4 + d);
          float x = fract(aSeed.x + uTime * uWind * mix(0.012, 0.05, d) + sway + uPan.x * mix(0.15, 0.9, d) / uAspect);
          gl_Position = vec4(x * 2.2 - 1.1, y * 2.2 - 1.1, 0.0, 1.0);
          gl_PointSize = mix(1.3, 12.0, d * d * d) * uScale;
          // fewer flakes when it snows lightly: drop by seed
          vA = step(aSeed.w, uAmount) * mix(0.22, 0.48, d);
          vSoft = mix(0.2, 0.8, d);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        varying float vSoft;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(1.0 - vSoft - 0.2, 1.0, r)) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(0.93, 0.96, 1.0, a);
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 999;
  }

  update(tSec: number, amount: number, pixelRatio: number, aspect: number, pan: THREE.Vector2): void {
    const u = this.mat.uniforms;
    u.uTime.value = tSec;
    u.uWind.value = 0.55 + 0.45 * Math.sin(tSec * 0.11) + 0.2 * Math.sin(tSec * 0.37);
    u.uAmount.value = amount;
    u.uScale.value = pixelRatio;
    u.uAspect.value = aspect;
    u.uPan.value.copy(pan);
  }
}
