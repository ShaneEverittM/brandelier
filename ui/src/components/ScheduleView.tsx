import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';

import type { ScheduleDoc, ScheduleEntry, ScheduleKind } from '../types';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_DURATION = 60;
const MIN_DURATION = 15;
const SNAP = 15;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

function formatMin(min: number): string {
  // min can be exactly 1440 (a block ending at day's end) — wrap that to
  // hour 0 rather than an invalid "24 PM".
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function newId(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

type Props = {
  schedule: ScheduleDoc;
  onSchedule: (next: ScheduleDoc) => void;
  positionPresets: string[];
  wavePresets: string[];
};

export function ScheduleView({ schedule, onSchedule, positionPresets, wavePresets }: Props) {
  const [pxPerHour, setPxPerHour] = useState(40);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const updateEntry = (id: string, patch: Partial<ScheduleEntry>) => {
    onSchedule({
      ...schedule,
      entries: schedule.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  };

  const removeEntry = (id: string) => {
    onSchedule({ ...schedule, entries: schedule.entries.filter((e) => e.id !== id) });
    if (selectedId === id) setSelectedId(null);
  };

  const createEntry = (day: number, startMin: number) => {
    const start = clamp(snap(startMin), 0, 1440 - MIN_DURATION);
    const duration = Math.min(DEFAULT_DURATION, 1440 - start);
    const kind: ScheduleKind = 'position';
    const preset = positionPresets[0] ?? '';
    const entry: ScheduleEntry = { id: newId(), day, startMin: start, durationMin: duration, kind, preset };
    onSchedule({ ...schedule, entries: [...schedule.entries, entry] });
    setSelectedId(entry.id);
  };

  const selected = schedule.entries.find((e) => e.id === selectedId) ?? null;

  return (
    <div className="schedule">
      <div className="target-radio">
        <label className={schedule.enabled ? 'active' : ''}>
          <input
            type="radio"
            checked={schedule.enabled}
            onChange={() => onSchedule({ ...schedule, enabled: true })}
          />
          Follow schedule
        </label>
        <label className={!schedule.enabled ? 'active' : ''}>
          <input
            type="radio"
            checked={!schedule.enabled}
            onChange={() => onSchedule({ ...schedule, enabled: false })}
          />
          Off
        </label>
      </div>

      <div className="row">
        <label>Zoom</label>
        <span className="value">{pxPerHour}px/h</span>
      </div>
      <input
        type="range"
        className="settings-slider"
        min={16}
        max={120}
        step={4}
        value={pxPerHour}
        onChange={(e) => setPxPerHour(parseInt(e.target.value))}
        style={{ marginBottom: 14 }}
      />

      {selected && (
        <div className="schedule-editor">
          <div className="schedule-editor-time">
            {DAY_NAMES[selected.day]}, {formatMin(selected.startMin)} – {formatMin(selected.startMin + selected.durationMin)}
          </div>
          <div className="target-radio">
            {(['position', 'wave'] as ScheduleKind[]).map((k) => (
              <label key={k} className={selected.kind === k ? 'active' : ''}>
                <input
                  type="radio"
                  checked={selected.kind === k}
                  onChange={() => {
                    const list = k === 'position' ? positionPresets : wavePresets;
                    updateEntry(selected.id, { kind: k, preset: list[0] ?? '' });
                  }}
                />
                {k === 'position' ? 'Position' : 'Wave'}
              </label>
            ))}
          </div>
          <div className="wave-select-row">
            <select
              className="wave-group-select"
              value={selected.preset}
              onChange={(e) => updateEntry(selected.id, { preset: e.target.value })}
            >
              {(selected.kind === 'position' ? positionPresets : wavePresets).length === 0 && (
                <option value="">No presets saved</option>
              )}
              {(selected.kind === 'position' ? positionPresets : wavePresets).map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <button
              className="btn danger"
              style={{ flex: 'none', padding: '0 8px' }}
              title="Delete block"
              onClick={() => removeEntry(selected.id)}
            >
              <svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor">
                <path d="M5 1h4a1 1 0 0 1 1 1H4a1 1 0 0 1 1-1ZM2 3h10l-.9 9H2.9L2 3Zm3 2v5h1V5H5Zm3 0v5h1V5H8Z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className="schedule-timeline">
        {DAY_NAMES.map((name, day) => (
          <DayTrack
            key={day}
            day={day}
            name={name}
            isToday={now.getDay() === day}
            nowMin={now.getHours() * 60 + now.getMinutes()}
            pxPerHour={pxPerHour}
            entries={schedule.entries.filter((e) => e.day === day)}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreate={(startMin) => createEntry(day, startMin)}
            onChange={(id, patch) => updateEntry(id, patch)}
          />
        ))}
      </div>
    </div>
  );
}

type DayTrackProps = {
  day: number;
  name: string;
  isToday: boolean;
  nowMin: number;
  pxPerHour: number;
  entries: ScheduleEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (startMin: number) => void;
  onChange: (id: string, patch: Partial<ScheduleEntry>) => void;
};

function DayTrack({ name, isToday, nowMin, pxPerHour, entries, selectedId, onSelect, onCreate, onChange }: DayTrackProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const height = 24 * pxPerHour;

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const min = ((e.clientY - rect.top) / pxPerHour) * 60;
    onCreate(min);
  };

  return (
    <div className="schedule-day">
      <div className="schedule-day-header">{name}</div>
      <div ref={trackRef} className="schedule-day-track" style={{ height }} onClick={handleTrackClick}>
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="schedule-hour-line" style={{ top: h * pxPerHour }}>
            <span>{formatMin(h * 60)}</span>
          </div>
        ))}
        {isToday && <div className="schedule-now-line" style={{ top: (nowMin / 60) * pxPerHour }} />}
        {entries.map((entry) => (
          <ScheduleBlock
            key={entry.id}
            entry={entry}
            pxPerHour={pxPerHour}
            selected={entry.id === selectedId}
            onSelect={() => onSelect(entry.id)}
            onChange={(patch) => onChange(entry.id, patch)}
          />
        ))}
      </div>
    </div>
  );
}

type BlockProps = {
  entry: ScheduleEntry;
  pxPerHour: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<ScheduleEntry>) => void;
};

type DragMode = 'move' | 'resize-top' | 'resize-bottom';

function ScheduleBlock({ entry, pxPerHour, selected, onSelect, onChange }: BlockProps) {
  const dragRef = useRef<{ mode: DragMode; startY: number; startMin: number; durationMin: number } | null>(null);

  const beginDrag = (mode: DragMode, e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { mode, startY: e.clientY, startMin: entry.startMin, durationMin: entry.durationMin };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaMin = snap(((e.clientY - drag.startY) / pxPerHour) * 60);
    if (drag.mode === 'move') {
      const startMin = clamp(drag.startMin + deltaMin, 0, 1440 - drag.durationMin);
      onChange({ startMin });
    } else if (drag.mode === 'resize-top') {
      const end = drag.startMin + drag.durationMin;
      const startMin = clamp(drag.startMin + deltaMin, 0, end - MIN_DURATION);
      onChange({ startMin, durationMin: end - startMin });
    } else {
      const durationMin = clamp(drag.durationMin + deltaMin, MIN_DURATION, 1440 - drag.startMin);
      onChange({ durationMin });
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      (e.target as Element).releasePointerCapture(e.pointerId);
      dragRef.current = null;
    }
  };

  const top = (entry.startMin / 60) * pxPerHour;
  const heightPx = (entry.durationMin / 60) * pxPerHour;

  return (
    <div
      className={`schedule-block schedule-block-${entry.kind}${selected ? ' selected' : ''}`}
      style={{ top, height: heightPx }}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
    >
      <div className="schedule-block-handle top" onPointerDown={(e) => beginDrag('resize-top', e)} />
      <div className="schedule-block-body" onPointerDown={(e) => beginDrag('move', e)}>
        <span className="schedule-block-label">{entry.preset || '(no preset)'}</span>
      </div>
      <div className="schedule-block-handle bottom" onPointerDown={(e) => beginDrag('resize-bottom', e)} />
    </div>
  );
}
