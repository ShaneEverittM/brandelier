import type { ReactNode } from 'react';

import type { Wave, WavePattern } from '../types';

const PATTERNS: { id: WavePattern; name: string; icon: ReactNode }[] = [
  { id: 'sine', name: 'Wave', icon: <path d="M2 8 Q 9 1 16 8 T 30 8 T 34 8" /> },
  {
    id: 'ripple',
    name: 'Ripple',
    icon: (
      <g>
        <circle cx="18" cy="8" r="2" fill="currentColor" />
        <circle cx="18" cy="8" r="6" />
        <circle cx="18" cy="8" r="10" />
      </g>
    ),
  },
  { id: 'breath', name: 'Breath', icon: <path d="M2 8 C 8 1, 14 1, 18 8 C 22 15, 28 15, 34 8" /> },
  {
    id: 'chase',
    name: 'Chase',
    icon: (
      <g>
        <line x1="3" y1="8" x2="9" y2="8" />
        <line x1="14" y1="8" x2="20" y2="8" />
        <line x1="25" y1="8" x2="33" y2="8" />
      </g>
    ),
  },
];

type Props = {
  wave: Wave;
  onWave: (next: Wave) => void;
  isPlaying: boolean;
  onPlay: () => void;
  onStop: () => void;
};

export function WavePanel({ wave, onWave, isPlaying, onPlay, onStop }: Props) {
  return (
    <div className="wave">
      <div className="rail-h">
        <h3>Wave Mode</h3>
        <span className="num">{isPlaying ? 'PLAYING' : 'PAUSED'}</span>
      </div>

      <div className="pattern-grid">
        {PATTERNS.map((p) => (
          <button
            key={p.id}
            className="pattern"
            aria-pressed={wave.pattern === p.id}
            onClick={() => onWave({ ...wave, pattern: p.id })}
          >
            <svg viewBox="0 0 36 16">{p.icon}</svg>
            <span className="pname">{p.name}</span>
          </button>
        ))}
      </div>

      <div className="row">
        <label>Amplitude</label>
        <span className="value">{Math.round(wave.amp * 100)}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={wave.amp}
        onChange={(e) => onWave({ ...wave, amp: parseFloat(e.target.value) })}
      />

      <div className="row">
        <label>Speed</label>
        <span className="value">{wave.speed.toFixed(2)}×</span>
      </div>
      <input
        type="range"
        min="0.1"
        max="3"
        step="0.05"
        value={wave.speed}
        onChange={(e) => onWave({ ...wave, speed: parseFloat(e.target.value) })}
      />

      <div className="row">
        <label>Phase spread</label>
        <span className="value">{Math.round(wave.phase * 360)}°</span>
      </div>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={wave.phase}
        onChange={(e) => onWave({ ...wave, phase: parseFloat(e.target.value) })}
      />

      <div className="action-row" style={{ marginTop: 14 }}>
        {isPlaying ? (
          <button className="btn primary" onClick={onStop}>
            Stop wave
          </button>
        ) : (
          <button className="btn primary" onClick={onPlay}>
            Start wave
          </button>
        )}
      </div>
    </div>
  );
}
