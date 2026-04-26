/* Camera widget — small orbital control in the stage corner */

import React from 'react';

export function CameraWidget({ camera, setCamera }) {
  const trackRef = React.useRef(null);

  const startDrag = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const start = { ...camera };
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setCamera({
        yaw: start.yaw + dx * 0.012,
        elevation: Math.max(-1.0, Math.min(1.4, start.elevation + dy * 0.008)),
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Visualize current camera as a small sphere with a dot
  const r = 26;
  const cx = 32, cy = 32;
  // Yaw moves dot around horizontally; elevation moves it vertically
  const dotX = cx + Math.sin(-camera.yaw) * r * 0.7;
  const dotY = cy + (camera.elevation - 0.5) * r * 1.1;

  const presets = [
    { name: 'Front', yaw: 0, elev: 0.18 },
    { name: 'Side', yaw: -Math.PI / 2, elev: 0.22 },
    { name: '3/4', yaw: -0.5, elev: 0.32 },
    { name: 'Up', yaw: 0, elev: -0.45 },
    { name: 'Top', yaw: 0, elev: 1.05 },
  ];

  return (
    <div className="camera-widget" onMouseDown={(e) => e.stopPropagation()}>
      <div className="cw-h">View</div>
      <div className="cw-globe-row">
        <div
          ref={trackRef}
          className="cw-globe"
          onMouseDown={startDrag}
          title="Drag to orbit"
        >
          <svg viewBox="0 0 64 64" width="64" height="64">
            <circle cx="32" cy="32" r="26" fill="var(--paper)" stroke="var(--rule)" strokeWidth="0.75" />
            <ellipse cx="32" cy="32" rx="26" ry="8" fill="none" stroke="var(--rule)" strokeWidth="0.5" />
            <line x1="6" y1="32" x2="58" y2="32" stroke="var(--rule)" strokeWidth="0.5" />
            <line x1="32" y1="6" x2="32" y2="58" stroke="var(--rule)" strokeWidth="0.5" />
            <circle cx={dotX} cy={dotY} r="3" fill="var(--ink)" />
          </svg>
        </div>
        <div className="cw-readout">
          <div><span>Yaw</span><b>{Math.round((camera.yaw * 180) / Math.PI)}°</b></div>
          <div><span>Tilt</span><b>{Math.round((camera.elevation * 180) / Math.PI)}°</b></div>
        </div>
      </div>
      <div className="cw-presets">
        {presets.map((p) => (
          <button
            key={p.name}
            onClick={() => setCamera({ yaw: p.yaw, elevation: p.elev })}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}

