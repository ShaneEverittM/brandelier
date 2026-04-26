export function Inspector({ selectedIds, bulbState, onClear, onZero }) {
  const n = selectedIds.size;
  if (n === 0) {
    return (
      <div className="inspector">
        <p className="empty">Nothing selected. Click a bulb, or its top-plate hole, to begin.</p>
      </div>
    );
  }

  let posSum = 0, brightSum = 0;
  selectedIds.forEach((id) => {
    const s = bulbState[id] || { pos: 0.5, bright: 0.7 };
    posSum += s.pos;
    brightSum += s.bright;
  });
  const avgPos = posSum / n;
  const avgBright = brightSum / n;
  const heightCm = Math.round(40 + avgPos * 80);

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
