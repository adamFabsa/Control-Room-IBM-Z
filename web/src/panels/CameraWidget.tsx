import { LocateFixed, RotateCcw, RotateCw, Volume2, VolumeX, ZoomIn, ZoomOut } from 'lucide-react';
import { useState } from 'react';
import { toggleMuted } from '../audio/sound';
import { useMuted } from '../audio/useMuted';
import { mapControls } from '../map/controls';
import type { Rot } from '../map/iso';
import { useStore } from '../store';

// Where north points on screen, in degrees clockwise from straight up, for each view rotation.
// The rig orbits at azimuth 45° + 90°·rot (world +x east, +z south) and 30° elevation, so at rot 0 the camera
// sits south-east of the county looking north-west: screen-up is NW, screen-right is NE, and north (−z) lands
// up-right, foreshortened to the 2:1 iso angle (atan(2) ≈ 63.4° from vertical). Each E press turns the camera
// a quarter turn, which swings north a quarter turn counter-clockwise on screen.
const NORTH_DEG = [63.43, -63.43, -116.57, 116.57] as const;
const NORTH_WORD = ['up and to the right', 'up and to the left', 'down and to the left', 'down and to the right'] as const;

/** The needle angle for `rot`, unwrapped so the CSS transition always takes the short way round. */
function useNorthAngle(rot: Rot): number {
  const [s, setS] = useState({ rot, deg: NORTH_DEG[rot] as number });
  if (s.rot !== rot) {
    let deg: number = NORTH_DEG[rot];
    while (deg - s.deg > 180) deg -= 360;
    while (deg - s.deg < -180) deg += 360;
    setS({ rot, deg });
    return deg;
  }
  return s.deg;
}

export function CameraWidget() {
  const rot = useStore((s) => s.ui.rot);
  const setUI = useStore((s) => s.setUI);
  const deg = useNorthAngle(rot);
  const muted = useMuted();

  return (
    <div className="panel camera-widget pop" role="group" aria-label="Camera and sound">
      <button type="button" className="gbtn cam-btn" aria-label="Rotate left (Q)" title="Rotate left · Q" onClick={() => setUI({ rot: ((rot + 3) % 4) as Rot })}>
        <RotateCcw size={18} strokeWidth={2.4} />
      </button>
      <div className="compass" role="img" aria-label={`Compass: north is ${NORTH_WORD[rot]}`} title="North">
        <span className="compass-needle" style={{ transform: `rotate(${deg}deg)` }}>
          <svg viewBox="0 0 50 50" aria-hidden="true">
            <path className="tail" d="M25 28 L25 37" />
            <path className="head" d="M25 12.5 L30.5 26 L25 23.2 L19.5 26 Z" />
            <circle className="hub" cx="25" cy="25" r="2.6" />
          </svg>
          <span className="compass-n" style={{ transform: `rotate(${-deg}deg)` }}>N</span>
        </span>
      </div>
      <button type="button" className="gbtn cam-btn" aria-label="Rotate right (E)" title="Rotate right · E" onClick={() => setUI({ rot: ((rot + 1) % 4) as Rot })}>
        <RotateCw size={18} strokeWidth={2.4} />
      </button>
      <button type="button" className="gbtn cam-btn" aria-label="Zoom out (−)" title="Zoom out · −" onClick={() => mapControls.zoomBy(0.8)}>
        <ZoomOut size={18} strokeWidth={2.4} />
      </button>
      <button type="button" className="gbtn cam-btn" aria-label="Recenter the county" title="Recenter" onClick={() => mapControls.refit()}>
        <LocateFixed size={18} strokeWidth={2.4} />
      </button>
      <button type="button" className="gbtn cam-btn" aria-label="Zoom in (+)" title="Zoom in · +" onClick={() => mapControls.zoomBy(1.25)}>
        <ZoomIn size={18} strokeWidth={2.4} />
      </button>
      <span className="cam-sep" aria-hidden="true" />
      <button
        type="button"
        className="gbtn cam-btn cam-mute"
        aria-label={muted ? 'Unmute sound (M)' : 'Mute sound (M)'}
        aria-pressed={muted}
        title={muted ? 'Unmute sound · M' : 'Mute sound · M'}
        onClick={toggleMuted}
      >
        {muted ? <VolumeX size={18} strokeWidth={2.4} /> : <Volume2 size={18} strokeWidth={2.4} />}
      </button>
    </div>
  );
}
