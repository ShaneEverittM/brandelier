import { useState } from 'react';

import type { Group } from '../types';

type Props = {
  groups: Group[];
  activeGroup: string | null;
  onActivate: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
  currentSelectionCount: number;
};

export function GroupsPanel({
  groups,
  activeGroup,
  onActivate,
  onCreate,
  onDelete,
  currentSelectionCount,
}: Props) {
  const [name, setName] = useState('');
  return (
    <div className="groups">
      <div className="groups-list">
        {groups.length === 0 && (
          <div className="group-item" style={{ cursor: 'default' }}>
            <span className="gname">
              <em>No groups yet — name a selection below</em>
            </span>
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
          placeholder={
            currentSelectionCount > 0 ? `Save ${currentSelectionCount} as…` : 'Select bulbs first'
          }
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
          onClick={() => {
            if (name.trim()) {
              onCreate(name.trim());
              setName('');
            }
          }}
        >
          Save
        </button>
        {(() => {
          const active = groups.find((g) => g.id === activeGroup);
          return active && !active.builtin ? (
            <button
              className="iconbtn danger"
              style={{ flex: 'none' }}
              onClick={() => {
                if (window.confirm(`Delete group "${active.name}"?`)) onDelete(active.id);
              }}
            >
              <svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor">
                <path d="M5 1h4a1 1 0 0 1 1 1H4a1 1 0 0 1 1-1ZM2 3h10l-.9 9H2.9L2 3Zm3 2v5h1V5H5Zm3 0v5h1V5H8Z" />
              </svg>
            </button>
          ) : null;
        })()}
      </div>
    </div>
  );
}
