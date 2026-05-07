import { useState } from 'react';

import type { Group } from '../types';

type Props = {
  groups: Group[];
  activeGroup: string | null;
  onActivate: (id: string) => void;
  onCreate: (name: string) => void;
  currentSelectionCount: number;
};

export function GroupsPanel({
  groups,
  activeGroup,
  onActivate,
  onCreate,
  currentSelectionCount,
}: Props) {
  const [name, setName] = useState('');
  return (
    <div className="groups">
      <div className="rail-h">
        <h3>Groups</h3>
        <span className="num">{groups.length} saved</span>
      </div>

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
      </div>
    </div>
  );
}
