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
  {
    id: 'spin',
    name: 'Spin',
    icon: (
      <g fill="none">
        <circle cx="18" cy="8" r="6" />
        <path d="M24 8 C24 4.7 21.3 2 18 2" strokeLinecap="round" />
        <path d="M15 1 L18 2 L16 5" fill="currentColor" stroke="none" />
      </g>
    ),
  },
];

function formatPeriod(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return sec === 0 ? `${m}m` : `${m}m ${sec}s`;
}

type Props = {
  wave: Wave;
  onWave: (next: Wave) => void;
  isPlaying: boolean;
  onPlay: () => void;
  onStop: () => void;
};

export function WavePanel({ wave, onWave, isPlaying, onPlay, onStop }: Props) {
  const isSpin = wave.pattern === 'spin';

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
            disabled={isPlaying}
            onClick={() => onWave({ ...wave, pattern: p.id })}
          >
            <svg viewBox="0 0 36 16">{p.icon}</svg>
            <span className="pname">{p.name}</span>
          </button>
        ))}
      </div>

      {isSpin ? (
        <>
          <div className="row">
            <label>Rotation period</label>
            <span className="value">{formatPeriod(wave.spinPeriod)}</span>
          </div>
          <input
            type="range"
            min="5"
            max="3600"
            step="1"
            value={wave.spinPeriod}
            disabled={isPlaying}
            onChange={(e) => onWave({ ...wave, spinPeriod: parseInt(e.target.value) })}
          />
        </>
      ) : (
        <>
          <div className="row">
            <label>Amplitude</label>
            <span className="value">{Math.round(wave.amp * 100)}%</span>
          </div>
          <input
            type="range"
            min="0.01"
            max="1"
            step="0.01"
            value={wave.amp}
            disabled={isPlaying}
            onChange={(e) => onWave({ ...wave, amp: parseFloat(e.target.value) })}
          />

          <div className="row">
            <label>Speed</label>
            <span className="value">{wave.speed.toFixed(2)}×</span>
          </div>
          <input
            type="range"
            min="0.01"
            max="2"
            step="0.01"
            value={wave.speed}
            disabled={isPlaying}
            onChange={(e) => onWave({ ...wave, speed: parseFloat(e.target.value) })}
          />

          <div className="row">
            <label>Wavelength</label>
            <span className="value">{wave.wavelength.toFixed(1)}</span>
          </div>
          <input
            type="range"
            min="0.2"
            max="10"
            step="0.1"
            value={wave.wavelength}
            disabled={isPlaying}
            onChange={(e) => onWave({ ...wave, wavelength: parseFloat(e.target.value) })}
          />

          {wave.pattern !== 'ripple' && (
            <>
              <div className="row">
                <label>Direction</label>
                <span className="value">{wave.direction}°</span>
              </div>
              <input
                type="range"
                min="0"
                max="359"
                step="1"
                value={wave.direction}
                disabled={isPlaying}
                onChange={(e) => onWave({ ...wave, direction: parseInt(e.target.value) })}
              />
            </>
          )}
        </>
      )}

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
