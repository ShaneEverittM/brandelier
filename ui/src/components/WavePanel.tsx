import type { ReactNode } from 'react';

import type { Group, Wave, WavePattern, WaveTarget } from '../types';

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

const fromQuad = (t: number, min: number, max: number) => min + (max - min) * t * t;
const toQuad = (v: number, min: number, max: number) => Math.sqrt((v - min) / (max - min));

function formatPeriod(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return sec === 0 ? `${m}m` : `${m}m ${sec}s`;
}

type Props = {
  wave: Wave;
  onWave: (next: Wave) => void;
  presets: string[];
  wavePresetName: string | null;
  onWavePresetName: (name: string | null) => void;
  groups: Group[];
  waveGroupId: string | null;
  onWaveGroupId: (id: string | null) => void;
  isPlaying: boolean;
  onPlay: () => void;
  onStop: () => void;
};

export function WavePanel({ wave, onWave, presets, wavePresetName, onWavePresetName, groups, waveGroupId, onWaveGroupId, isPlaying, onPlay, onStop }: Props) {
  const isSpin = wave.pattern === 'spin';

  return (
    <div className="wave">
      <div className="rail-h">
        <h3>Wave Mode</h3>
        <span className="num">{isPlaying ? 'PLAYING' : 'PAUSED'}</span>
      </div>

      <div className="wave-select-row">
        <span className="wave-select-label">Preset</span>
        <select
          className="wave-group-select"
          value={wavePresetName ?? ''}
          disabled={isPlaying}
          onChange={(e) => onWavePresetName(e.target.value || null)}
        >
          <option value="">Current</option>
          {presets.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
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

      <div className="wave-select-row">
        <span className="wave-select-label">Group</span>
        <select
          className="wave-group-select"
          value={waveGroupId ?? ''}
          disabled={isPlaying}
          onChange={(e) => onWaveGroupId(e.target.value || null)}
        >
          <option value="">Current selection</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>

      <div className="target-radio">
        {(['extension', 'brightness'] as WaveTarget[]).map((t) => (
          <label key={t} className={wave.target === t ? 'active' : ''}>
            <input
              type="radio"
              name="wave-target"
              value={t}
              checked={wave.target === t}
              disabled={isPlaying}
              onChange={() => onWave({ ...wave, target: t })}
            />
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </label>
        ))}
      </div>

      {isSpin ? (
        <>
          <div className="row">
            <label>Rotation period</label>
            <span className="value">{formatPeriod(wave.spinPeriod)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="range"
              min="0"
              max="1"
              step="0.001"
              value={toQuad(wave.spinPeriod, 5, 3600)}
              disabled={isPlaying}
              style={{ flex: 1 }}
              onChange={(e) => onWave({ ...wave, spinPeriod: Math.round(fromQuad(parseFloat(e.target.value), 5, 3600)) })}
            />
            <button
              className="iconbtn"
              disabled={isPlaying}
              title="Reverse direction"
              onClick={() => onWave({ ...wave, spinReverse: !wave.spinReverse })}
            >
              <svg viewBox="0 0 14 14" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: wave.spinReverse ? 'scaleX(-1)' : undefined }}>
                <path d="M11 7A4 4 0 1 0 7 11" />
                <path d="M7 9.5 L9 11 L7 12.5" />
              </svg>
            </button>
          </div>
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
            min="0"
            max="1"
            step="0.001"
            value={toQuad(wave.speed, 0.01, 5)}
            disabled={isPlaying}
            onChange={(e) => onWave({ ...wave, speed: fromQuad(parseFloat(e.target.value), 0.01, 5) })}
          />

          <div className="row">
            <label>Wavelength</label>
            <span className="value">{wave.wavelength.toFixed(1)}</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.001"
            value={toQuad(wave.wavelength, 0.2, 10)}
            disabled={isPlaying}
            onChange={(e) => onWave({ ...wave, wavelength: fromQuad(parseFloat(e.target.value), 0.2, 10) })}
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
