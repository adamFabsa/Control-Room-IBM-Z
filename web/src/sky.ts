// Dallas daylight during Winter Storm Uri (Feb 14–19, 2021, CST): sunrise about 7:12 AM, sunset about 6:15 PM.
// Shared by the 3D county (lighting) and the HUD (the sky dial), so both agree on when it's dark.
export const SUNRISE = 7.2;
export const SUNSET = 18.25;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 0 in full daylight, 1 in full dark; twilight eases in about 50 minutes either side of the sun line. */
export function nightAt(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h < 12) return 1 - smooth(SUNRISE - 0.75, SUNRISE + 0.85, h);
  return smooth(SUNSET - 0.85, SUNSET + 0.7, h);
}

/** 0–1: how much of a sunrise or sunset glow to add to the light. */
export function goldenAt(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const g = (c: number) => Math.exp(-(((h - c) / 0.55) ** 2));
  return Math.max(g(SUNRISE + 0.1), g(SUNSET - 0.1));
}

export type SkyPhase = 'night' | 'dawn' | 'day' | 'dusk';
export function skyPhase(hour: number): SkyPhase {
  const n = nightAt(hour);
  if (n > 0.85) return 'night';
  if (n < 0.15) return 'day';
  return hour < 12 ? 'dawn' : 'dusk';
}
