import type { Action, GameState } from '../contracts';

export interface GameLink {
  kind: 'mock' | 'ws';
  start(onState: (s: GameState) => void, onStatus: (connected: boolean) => void): void;
  send(a: Action): void;
  stop(): void;
}

export function wsUrl(): string {
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/** Mock when asked (?mock=1), or when running the Vite dev server with no server URL configured. */
export function wantMock(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.get('mock') === '1') return true;
  if (q.get('mock') === '0') return false;
  return !import.meta.env.VITE_WS_URL && location.port === '5173';
}
