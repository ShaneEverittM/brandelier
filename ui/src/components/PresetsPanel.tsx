import { useState } from 'react';

import type { PresetKind } from '../types';

type Props = {
  kind: PresetKind;
  presets: string[];
  previewing: { name: string; kind: PresetKind } | null;
  onPreview: (name: string) => void;
  onCancelPreview: () => void;
  onLoad: () => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
};

export function PresetsPanel({
  kind,
  presets,
  previewing,
  onPreview,
  onCancelPreview,
  onLoad,
  onSave,
  onDelete,
}: Props) {
  const [saveName, setSaveName] = useState('');
  const activeInSection = previewing?.kind === kind ? previewing.name : null;

  const handleSave = () => {
    const name = saveName.trim();
    if (!name) return;
    onSave(name);
    setSaveName('');
  };

  return (
    <div className="presets">
      <div className="presets-list">
        {presets.length === 0 && (
          <div className="preset-item" style={{ cursor: 'default' }}>
            <span className="pname">
              <em>No presets yet — name and save below</em>
            </span>
          </div>
        )}
        {presets.map((name) => (
          <div
            key={name}
            className={`preset-item${activeInSection === name ? ' active' : ''}`}
            onClick={() => (activeInSection === name ? onCancelPreview() : onPreview(name))}
          >
            <span className="pname">{name}</span>
          </div>
        ))}
      </div>

      {activeInSection && (
        <div className="preset-actions">
          <button className="btn primary" style={{ flex: 1 }} onClick={onLoad}>
            Load
          </button>
          <button className="btn" style={{ flex: 'none' }} onClick={onCancelPreview}>
            Cancel
          </button>
          <button
            className="btn danger"
            style={{ flex: 'none' }}
            onClick={() => { if (window.confirm(`Delete preset "${activeInSection}"?`)) onDelete(activeInSection); }}
          >
            <svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor">
              <path d="M5 1h4a1 1 0 0 1 1 1H4a1 1 0 0 1 1-1ZM2 3h10l-.9 9H2.9L2 3Zm3 2v5h1V5H5Zm3 0v5h1V5H8Z" />
            </svg>
          </button>
        </div>
      )}

      <div className="preset-add">
        <input
          type="text"
          placeholder="Preset name"
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
