import { useSyncExternalStore } from 'react';
import { isMuted, subscribeMuted } from './sound';

/** Whether game sound is muted; re-renders when it changes (button, M key, or another component). */
export function useMuted(): boolean {
  return useSyncExternalStore(subscribeMuted, isMuted, isMuted);
}
