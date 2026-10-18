export type Pick = { kind: 'circuit'; id: string } | { kind: 'building'; id: string; circuit: string };

export interface SceneUI {
  hover: Pick | null;
  selected: string | null;
  tool: string;
  /** What the current tool can be placed on, pulsed on the map. */
  targets?: 'circuits' | 'buildings' | null;
}

/** What the HTML overlay and the panels need from the map renderer. */
export interface MapScene {
  onFrame(fn: () => void): () => void;
  toScreen(gx: number, gy: number, y: number, out: { x: number; y: number }): { x: number; y: number };
  topOf(id: string): number;
  /** Camera zoom: 1 shows the whole county. */
  getZoom(): number;
  /** 0 in daylight, 1 at night. */
  getNight(): number;
}
