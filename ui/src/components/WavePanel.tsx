import { useState } from 'react';
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

const DEFAULT_WAVE: Wave = {
  pattern: 'sine',
  target: 'extension',
  amp: 0.1,
  speed: 1.0,
  wavelength: 1.0,
  direction: 0,
  spinPeriod: 30,
  spinReverse: false,
  groupId: 'g0',
};

const fromQuad = (t: number, min: number, max: number) => min + (max - min) * t * t;
const toQuad = (v: number, min: number, max: number) => Math.sqrt((v - min) / (max - min));

function formatPeriod(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return sec === 0 ? `${m}m` : `${m}m ${sec}s`;
}

type WaveEditorProps = {
  wave: Wave;
  index: number;
  isPlaying: boolean;
  groups: Group[];
  onChange: (next: Wave) => void;
  onRemove: () => void;
};

function WaveEditor({ wave, index, isPlaying, groups, onChange, onRemove }: WaveEditorProps) {
  const [open, setOpen] = useState(true);
  const isSpin = wave.pattern === 'spin';

  return (
    <div className="wave-block">
      <div className="wave-sep">
        <span style={{ cursor: 'pointer', flex: 1 }} onClick={() => setOpen((o) => !o)}>
          Wave {index + 1}
          <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ marginLeft: 6, transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s', verticalAlign: 'middle' }}>
            <path d="M1 1l4 4 4-4" />
          </svg>
        </span>
        {index > 0 && !isPlaying && (
          <button className="iconbtn" title="Remove wave" onClick={onRemove}>
            <svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor">
              <path d="M5 1h4a1 1 0 0 1 1 1H4a1 1 0 0 1 1-1ZM2 3h10l-.9 9H2.9L2 3Zm3 2v5h1V5H5Zm3 0v5h1V5H8Z" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div className="wave-body">
          <div className="wave-sep-line" />

          <div className="pattern-grid">
            {PATTERNS.map((p) => (
              <button
                key={p.id}
                className="pattern"
                aria-pressed={wave.pattern === p.id}
                disabled={isPlaying}
                onClick={() => onChange({ ...wave, pattern: p.id })}
              >
                <svg viewBox="0 0 36 16">{p.icon}</svg>
                <span className="pname">{p.name}</span>
              </button>
            ))}
          </div>

          <div className="target-radio">
            {(['extension', 'brightness'] as WaveTarget[]).map((t) => (
              <label key={t} className={wave.target === t ? 'active' : ''}>
                <input
                  type="radio"
                  name={`wave-target-${index}`}
                  value={t}
                  checked={wave.target === t}
                  disabled={isPlaying}
                  onChange={() => onChange({ ...wave, target: t })}
                />
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </label>
            ))}
          </div>

          <div className="wave-select-row">
            <span className="wave-select-label">Group</span>
            <select
              className="wave-group-select"
              value={wave.groupId ?? ''}
              disabled={isPlaying}
              onChange={(e) => onChange({ ...wave, groupId: e.target.value || null })}
            >
              <option value="">Current selection</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
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
                  onChange={(e) => onChange({ ...wave, spinPeriod: Math.round(fromQuad(parseFloat(e.target.value), 5, 3600)) })}
                />
                <button
                  className="iconbtn"
                  disabled={isPlaying}
                  title="Reverse direction"
                  onClick={() => onChange({ ...wave, spinReverse: !wave.spinReverse })}
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
                onChange={(e) => onChange({ ...wave, amp: parseFloat(e.target.value) })}
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
                onChange={(e) => onChange({ ...wave, speed: fromQuad(parseFloat(e.target.value), 0.01, 5) })}
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
                onChange={(e) => onChange({ ...wave, wavelength: fromQuad(parseFloat(e.target.value), 0.2, 10) })}
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
                    onChange={(e) => onChange({ ...wave, direction: parseInt(e.target.value) })}
                  />
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

type Props = {
  waves: Wave[];
  onWaves: (next: Wave[]) => void;
  positionPresets: string[];
  brightnessPresets: string[];
  wavePosPresetName: string | null;
  onWavePosPresetName: (name: string | null) => void;
  waveBrightPresetName: string | null;
  onWaveBrightPresetName: (name: string | null) => void;
  groups: Group[];
  wavePresets: string[];
  onLoadWavePreset: (name: string) => void;
  onSaveWavePreset: (name: string) => void;
  onDeleteWavePreset: (name: string) => void;
  isPlaying: boolean;
  onPlay: () => void;
  onStop: () => void;
};

export function WavePanel({ waves, onWaves, positionPresets, brightnessPresets, wavePosPresetName, onWavePosPresetName, waveBrightPresetName, onWaveBrightPresetName, groups, wavePresets, onLoadWavePreset, onSaveWavePreset, onDeleteWavePreset, isPlaying, onPlay, onStop }: Props) {
  const [saveName, setSaveName] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('');

  const updateWave = (i: number, next: Wave) => {
    const updated = waves.map((w, idx) => (idx === i ? next : w));
    onWaves(updated);
  };

  const removeWave = (i: number) => {
    onWaves(waves.filter((_, idx) => idx !== i));
  };

  const addWave = () => {
    onWaves([...waves, { ...DEFAULT_WAVE }]);
  };

  const handleSave = () => {
    const name = saveName.trim();
    if (!name) return;
    onSaveWavePreset(name);
    setSaveName('');
  };

  return (
    <div className="wave">
      <div className="wave-select-row">
        <span className="wave-select-label">Wave preset</span>
        <select
          className="wave-group-select"
          value={selectedPreset}
          disabled={isPlaying}
          onChange={(e) => {
            setSelectedPreset(e.target.value);
            if (e.target.value) onLoadWavePreset(e.target.value);
          }}
        >
          <option value="">Load…</option>
          {wavePresets.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {selectedPreset && (
          <button
            className="btn danger"
            style={{ flex: 'none', padding: '0 8px', alignSelf: 'stretch' }}
            disabled={isPlaying}
            title={`Delete "${selectedPreset}"`}
            onClick={() => {
              if (window.confirm(`Delete preset "${selectedPreset}"?`)) {
                onDeleteWavePreset(selectedPreset);
                setSelectedPreset('');
              }
            }}
          >
            <svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor">
              <path d="M5 1h4a1 1 0 0 1 1 1H4a1 1 0 0 1 1-1ZM2 3h10l-.9 9H2.9L2 3Zm3 2v5h1V5H5Zm3 0v5h1V5H8Z" />
            </svg>
          </button>
        )}
      </div>

      <div className="wave-select-row">
        <span className="wave-select-label">Position preset</span>
        <select
          className="wave-group-select"
          value={wavePosPresetName ?? ''}
          disabled={isPlaying}
          onChange={(e) => onWavePosPresetName(e.target.value || null)}
        >
          <option value="">Current</option>
          {positionPresets.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      <div className="wave-select-row">
        <span className="wave-select-label">Brightness preset</span>
        <select
          className="wave-group-select"
          value={waveBrightPresetName ?? ''}
          disabled={isPlaying}
          onChange={(e) => onWaveBrightPresetName(e.target.value || null)}
        >
          <option value="">Current</option>
          {brightnessPresets.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      {waves.map((w, i) => (
        <WaveEditor
          key={i}
          wave={w}
          index={i}
          isPlaying={isPlaying}
          groups={groups}
          onChange={(next) => updateWave(i, next)}
          onRemove={() => removeWave(i)}
        />
      ))}

      <div className="wave-sep-line" />

      <div className="action-row" style={{ marginTop: 8 }}>
        {!isPlaying && (
          <button className="btn" onClick={addWave}>
            + Add wave
          </button>
        )}
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

      <div className="preset-add" style={{ marginTop: 8 }}>
        <input
          type="text"
          placeholder="Save wave preset…"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
        />
        <button
          className="btn primary"
          style={{ flex: 'none' }}
          disabled={!saveName.trim()}
          onClick={handleSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}
