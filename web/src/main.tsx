import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { mapControls } from './map/controls';
import './styles.css';

// Never let the browser zoom the page itself: a trackpad pinch (a wheel event with ctrlKey) or Ctrl+scroll over a
// panel would magnify everything and push the panels off-screen, and pinching back over the map only zooms the map.
// So pinch and Ctrl+scroll always zoom the map (the canvas handles its own; this covers the panels).
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (!(e.target instanceof HTMLCanvasElement)) mapControls.zoomBy(Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
// Safari sends pinches as gesture events
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
