/* Right rail panels */

import React from 'react';

export function Inspector({ selectedIds, bulbState, onBrightChange, onPosChange, onClear, onZero }) {
  const n = selectedIds.size;
  if (n === 0) {
    return (
      <div className="inspector">
        <p className="empty">Nothing selected. Click a bulb, or its top-plate hole, to begin.</p>
      </div>
    );
  }

  // Aggregate
  let posSum = 0, brightSum = 0;
  selectedIds.forEach((id) => {
    const s = bulbState[id] || { pos: 0.5, bright: 0.7 };
    posSum += s.pos;
    brightSum += s.bright;
  });
  const avgPos = posSum / n;
  const avgBright = brightSum / n;
  const heightCm = Math.round(40 + avgPos * 80); // 40..120cm display

  return (
    <div className="inspector">
      <div className="stat-grid">
        <div className="stat">
          <div className="lbl">Drop</div>
          <div className="val">{heightCm}<span className="unit">cm</span></div>
        </div>
        <div className="stat">
          <div className="lbl">Brightness</div>
          <div className="val">{Math.round(avgBright * 100)}<span className="unit">%</span></div>
        </div>
      </div>
      <div className="action-row">
        <button className="btn" onClick={onZero}>Re-zero</button>
        <button className="btn" onClick={onClear}>Deselect</button>
      </div>
    </div>
  );
}

const PATTERNS = [
  { id: 'sine', name: 'Wave', icon: <path d="M2 8 Q 9 1 16 8 T 30 8 T 34 8" /> },
  { id: 'ripple', name: 'Ripple', icon: <g><circle cx="18" cy="8" r="2" fill="currentColor" /><circle cx="18" cy="8" r="6" /><circle cx="18" cy="8" r="10" /></g> },
  { id: 'breath', name: 'Breath', icon: <path d="M2 8 C 8 1, 14 1, 18 8 C 22 15, 28 15, 34 8" /> },
  { id: 'chase', name: 'Chase', icon: <g><line x1="3" y1="8" x2="9" y2="8" /><line x1="14" y1="8" x2="20" y2="8" /><line x1="25" y1="8" x2="33" y2="8" /></g> },
];

export function WavePanel({ wave, onWave, isPlaying, onPlay, onStop }) {
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
        type="range" min="0" max="1" step="0.01"
        value={wave.amp}
        onChange={(e) => onWave({ ...wave, amp: parseFloat(e.target.value) })}
      />

      <div className="row">
        <label>Speed</label>
        <span className="value">{wave.speed.toFixed(2)}×</span>
      </div>
      <input
        type="range" min="0.1" max="3" step="0.05"
        value={wave.speed}
        onChange={(e) => onWave({ ...wave, speed: parseFloat(e.target.value) })}
      />

      <div className="row">
        <label>Phase spread</label>
        <span className="value">{Math.round(wave.phase * 360)}°</span>
      </div>
      <input
        type="range" min="0" max="1" step="0.01"
        value={wave.phase}
        onChange={(e) => onWave({ ...wave, phase: parseFloat(e.target.value) })}
      />

      <div className="action-row" style={{ marginTop: 14 }}>
        {isPlaying ? (
          <button className="btn primary" onClick={onStop}>Stop wave</button>
        ) : (
          <button className="btn primary" onClick={onPlay}>Start wave</button>
        )}
      </div>
    </div>
  );
}

export function GroupsPanel({ groups, activeGroup, onActivate, onCreate, onDelete, currentSelectionCount }) {
  const [name, setName] = React.useState('');
  return (
    <div className="groups">
      <div className="rail-h">
        <h3>Groups</h3>
        <span className="num">{groups.length} saved</span>
      </div>

      <div className="groups-list">
        {groups.length === 0 && (
          <div className="group-item" style={{ cursor: 'default' }}>
            <span className="gname"><em>No groups yet — name a selection below</em></span>
          </div>
        )}
        {groups.map((g) => (
          <div
            key={g.id}
            className={`group-item ${activeGroup === g.id ? 'active' : ''}`}
            onClick={() => onActivate(g.id)}
          >
            <span className="gname">{g.name}</span>
            <span className="gcount">{g.ids.length} bulbs</span>
          </div>
        ))}
      </div>

      <div className="group-add">
        <input
          type="text"
          placeholder={currentSelectionCount > 0 ? `Save ${currentSelectionCount} as…` : 'Select bulbs first'}
          value={name}
          disabled={currentSelectionCount === 0}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) {
              onCreate(name.trim());
              setName('');
            }
          }}
        />
        <button
          className="btn primary"
          style={{ flex: 'none' }}
          disabled={!name.trim() || currentSelectionCount === 0}
          onClick={() => { if (name.trim()) { onCreate(name.trim()); setName(''); } }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

