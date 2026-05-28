import type { BulbId, BulbState, BulbStatusMap } from '../types';

type Props = {
  selectedIds: Set<BulbId>;
  bulbState: BulbState;
  bulbStatus?: BulbStatusMap;
  maxLength: number;
  onClear: () => void;
  onZero: () => void;
};

const STATUS_NOTICES: {
  key: keyof NonNullable<BulbStatusMap[string]>;
  color: string;
  label: string;
  description: string;
}[] = [
  { key: 'read_error',      color: 'oklch(0.65 0.28 330)', label: 'Not responding',      description: 'Bulb is not responding over I2C. Check power and connections.' },
  { key: 'disabled',        color: 'oklch(0.50 0 0)',      label: 'Disabled',            description: 'The disable switch on this bulb is engaged.' },
  { key: 'max_speed_warn',  color: 'oklch(0.72 0.22 50)',  label: 'Max speed',           description: 'Motor is running at full speed. Check for obstructions or a stuck cord.' },
  { key: 'zeroing',         color: 'oklch(0.65 0.20 230)', label: 'Zeroing',             description: 'Bulb is homing to its reference position.' },
  { key: 'drift_detected',  color: 'oklch(0.80 0.18 85)',  label: 'Drift detected',      description: 'Bulb is not reaching its target position — cord may be slack.' },
];

export function Inspector({ selectedIds, bulbState, bulbStatus, maxLength, onClear, onZero }: Props) {
  const n = selectedIds.size;
  if (n === 0) {
    return (
      <div className="inspector">
        <p className="empty">Nothing selected. Click a bulb, or its top-plate hole, to begin.</p>
      </div>
    );
  }

  let posSum = 0,
    brightSum = 0;
  selectedIds.forEach((id) => {
    const s = bulbState[id] || { pos: 0.5, bright: 0.7 };
    posSum += s.pos;
    brightSum += s.bright;
  });
  const avgPos = posSum / n;
  const avgBright = brightSum / n;
  const dropIn = (avgPos * maxLength).toFixed(1);

  const activeNotices = bulbStatus
    ? STATUS_NOTICES.filter((notice) =>
        [...selectedIds].some((id) => bulbStatus[id]?.[notice.key])
      )
    : [];

  return (
    <div className="inspector">
      <div className="stat-grid">
        <div className="stat">
          <div className="lbl">Drop</div>
          <div className="val">
            {dropIn}
            <span className="unit">in</span>
          </div>
        </div>
        <div className="stat">
          <div className="lbl">Brightness</div>
          <div className="val">
            {Math.round(avgBright * 100)}
            <span className="unit">%</span>
          </div>
        </div>
      </div>
      {activeNotices.length > 0 && (
        <div className="inspector-notices">
          {activeNotices.map((notice) => (
            <div key={notice.key} className="inspector-notice" style={{ borderColor: notice.color }}>
              <span className="inspector-notice-dot" style={{ background: notice.color }} />
              <div>
                <div className="inspector-notice-label">{notice.label}</div>
                <div className="inspector-notice-desc">{notice.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="action-row">
        <button className="btn" onClick={onZero}>
          Re-zero
        </button>
        <button className="btn" onClick={onClear}>
          Deselect
        </button>
      </div>
    </div>
  );
}
