// Small display helpers shared by the HUD panels.

/** 560,000 → "560K", 1,040,000 → "1.04M". Fixed, short widths for the stat pills. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 999_500) return `${(n / 1e6).toFixed(a >= 9_995_000 ? 1 : 2)}M`;
  if (a >= 9_950) return `${Math.round(n / 1e3)}K`;
  if (a >= 1_000) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** "14:05" → { hm: "2:05", ampm: "PM" } */
export function clock12(hhmm: string): { hm: string; ampm: 'AM' | 'PM' } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hm: `${h % 12 || 12}:${String(m).padStart(2, '0')}`, ampm: h < 12 ? 'AM' : 'PM' };
}

/** Cut length chips: 30m 1h 2h 4h ∞ */
export const minutesChip = (m: number | null) => (m == null ? '∞' : m < 60 ? `${m}m` : `${m / 60}h`);

/** Cut length in a sentence: "for 30 min", "for 2 h", "until you restore it" */
export const minutesWords = (m: number | null) => (m == null ? 'until you restore it' : m < 60 ? `for ${m} min` : `for ${m / 60} h`);
