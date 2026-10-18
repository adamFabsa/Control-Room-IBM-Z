import type { Action, GameState } from '../contracts';
import type { GameLink } from './GameLink';

/** WebSocket to Adam's server: state JSON out, action JSON in. Reconnects with backoff. */
export function wsLink(url: string): GameLink {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    kind: 'ws',
    start(onState, onStatus) {
      const open = () => {
        if (stopped) return;
        ws = new WebSocket(url);
        ws.onopen = () => { delay = 500; onStatus(true); };
        ws.onmessage = (m) => {
          try {
            const data = JSON.parse(m.data as string);
            const s = (data && data.state ? data.state : data) as GameState;
            if (s && Array.isArray(s.circuits)) onState(s);
          } catch { /* ignore malformed frames */ }
        };
        ws.onclose = () => {
          onStatus(false);
          if (!stopped) { timer = setTimeout(open, delay); delay = Math.min(5000, delay * 2); }
        };
        ws.onerror = () => ws?.close();
      };
      open();
    },
    send(a: Action) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(a));
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
