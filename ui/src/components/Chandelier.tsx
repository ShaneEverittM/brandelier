/* Chandelier — 3D scene with positionable camera.
   Real 3D positions: 1 center + 6 inner ring (r=1) + 12 outer ring (r=2).
   Camera: yaw (rotate around Y) + elevation (tilt). Front view is yaw=0,elev=12°.
*/

import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type {
  Bulb,
  BulbId,
  BulbState,
  Camera,
  DragAxis,
  DragDelta,
  RenderStyle,
} from '../types';

const TAU = Math.PI * 2;

function buildBulbLayout(): Bulb[] {
  const bulbs: Bulb[] = [];
  bulbs.push({ id: 'c', ring: 0, ringIndex: 0, x3: 0, z3: 0 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + Math.PI / 6;
    bulbs.push({
      id: `r1-${i}`, ring: 1, ringIndex: i,
      x3: Math.cos(a),
      z3: Math.sin(a),
    });
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    bulbs.push({
      id: `r2-${i}`, ring: 2, ringIndex: i,
      x3: Math.cos(a) * 2.0,
      z3: Math.sin(a) * 2.0,
    });
  }
  return bulbs;
}

export const BULBS = buildBulbLayout();

const SVG_W = 920;
const SVG_H = 620;
const CENTER_X = SVG_W / 2;
const CENTER_Y = 140;
const WORLD_SCALE = 110;
const CAMERA_DIST = 9;
const FOV_FACTOR = 7;
const BULB_R_BASE = 30;
const TOP_HOLE_R = 5.5;
const MAX_DROP = 6.5;
const MIN_DROP = 0.6;

type Projected = { x: number; y: number; z: number; scale: number };

// 3D point projection: rotate by yaw around Y, tilt by elevation, then perspective
function project(x: number, y: number, z: number, yaw: number, elevation: number): Projected {
  // yaw rotates around Y axis (top-down spin)
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy - z * sy;
  const z1 = x * sy + z * cy;
  // elevation rotates around X axis (tilt camera up/down)
  const ce = Math.cos(elevation), se = Math.sin(elevation);
  const y2 = y * ce - z1 * se;
  const z2 = y * se + z1 * ce;
  // perspective
  const camZ = CAMERA_DIST + z2;
  const persp = FOV_FACTOR / Math.max(0.5, camZ);
  return {
    x: CENTER_X + x1 * WORLD_SCALE * persp,
    y: CENTER_Y + y2 * WORLD_SCALE * persp,
    z: camZ,
    scale: persp,
  };
}

// Plate ellipse path in 3D — sample points on circle at y=0
function platePath(yaw: number, elevation: number): Projected[] {
  const N = 48;
  const pts: Projected[] = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU;
    const p = project(Math.cos(a) * 2.6, 0, Math.sin(a) * 2.6, yaw, elevation);
    pts.push(p);
  }
  return pts;
}

// Plate as solid filled with depth shading: build outer + inner offset for thickness
function platePathString(pts: Projected[]): string {
  return pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ') + ' Z';
}

type DragState = {
  id: BulbId;
  startX: number;
  startY: number;
  axis: DragAxis;
  lastX: number;
  lastY: number;
};

type ChandelierProps = {
  bulbState: BulbState;
  selection: Set<BulbId>;
  onSelect: (id: BulbId, additive: boolean) => void;
  onClear: () => void;
  onDrag: (delta: DragDelta) => void;
  onDragEnd: () => void;
  onLongPress?: (id: BulbId) => void;
  renderStyle: RenderStyle;
  camera: Camera;
};

// ── Chandelier component ────────────────────────────────────────────
export function Chandelier({
  bulbState,
  selection,
  onSelect,
  onClear,
  onDrag,
  onDragEnd,
  onLongPress,
  renderStyle,
  camera,
}: ChandelierProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleBulbDown = (e: ReactMouseEvent, bulb: Bulb) => {
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey;
    onSelect(bulb.id, additive);

    longPressRef.current = setTimeout(() => {
      onLongPress?.(bulb.id);
      longPressRef.current = null;
    }, 700);

    setDrag({ id: bulb.id, startX: e.clientX, startY: e.clientY, axis: null, lastX: e.clientX, lastY: e.clientY });
  };

  const handleTopHoleDown = (e: ReactMouseEvent, bulb: Bulb) => {
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey;
    onSelect(bulb.id, additive);
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      if (longPressRef.current) {
        const moved = Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY);
        if (moved > 6) {
          clearTimeout(longPressRef.current);
          longPressRef.current = null;
        }
      }
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      let axis = drag.axis;
      if (!axis) {
        const totalDx = Math.abs(e.clientX - drag.startX);
        const totalDy = Math.abs(e.clientY - drag.startY);
        if (totalDx + totalDy > 4) {
          axis = totalDy > totalDx ? 'y' : 'x';
        }
      }
      onDrag({ dx, dy, axis });
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.axis = axis;
    };
    const onUp = () => {
      if (longPressRef.current) clearTimeout(longPressRef.current);
      longPressRef.current = null;
      onDragEnd();
      setDrag(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, onDrag, onDragEnd]);

  const { yaw, elevation } = camera;

  // Project all bulbs
  const projected = BULBS.map((b) => {
    const state = bulbState[b.id] || { pos: 0.5, bright: 0 };
    const dropY = MIN_DROP + state.pos * (MAX_DROP - MIN_DROP);
    const top = project(b.x3, 0, b.z3, yaw, elevation);
    const bot = project(b.x3, dropY, b.z3, yaw, elevation);
    return { bulb: b, state, top, bot };
  });

  // Sort back-to-front by bottom z
  const drawOrder = [...projected].sort((a, b) => b.bot.z - a.bot.z);

  const plate = platePath(yaw, elevation);
  const plateStr = platePathString(plate);

  return (
    <div className="chandelier-wrap" onMouseDown={onClear}>
      <svg
        className="chandelier"
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="bulb-glow" cx="50%" cy="40%" r="55%">
            <stop offset="0%" stopColor="oklch(0.96 0.06 80)" />
            <stop offset="60%" stopColor="oklch(0.86 0.10 70)" />
            <stop offset="100%" stopColor="oklch(0.78 0.13 70)" />
          </radialGradient>
          <radialGradient id="bulb-off" cx="50%" cy="35%" r="60%">
            <stop offset="0%" stopColor="var(--paper)" />
            <stop offset="80%" stopColor="var(--paper-3)" />
            <stop offset="100%" stopColor="var(--ink-4)" stopOpacity="0.6" />
          </radialGradient>
          <filter id="big-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="14" />
          </filter>
          <linearGradient id="plate-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--paper-3)" />
            <stop offset="100%" stopColor="var(--paper-2)" />
          </linearGradient>
        </defs>

        {/* Ceiling plate disc */}
        <path
          d={plateStr}
          fill="url(#plate-grad)"
          stroke="var(--rule)"
          strokeWidth="0.75"
        />

        {/* Top-plate holes (sorted back-to-front) */}
        {[...projected]
          .sort((a, b) => b.top.z - a.top.z)
          .map(({ bulb, top }) => {
            const isSel = selection.has(bulb.id);
            return (
              <circle
                key={`hole-${bulb.id}`}
                cx={top.x}
                cy={top.y}
                r={TOP_HOLE_R * top.scale}
                fill={isSel ? 'var(--select)' : 'var(--paper)'}
                stroke={isSel ? 'var(--select)' : 'var(--ink-3)'}
                strokeWidth="0.6"
                style={{ cursor: 'pointer' }}
                onMouseDown={(e) => handleTopHoleDown(e, bulb)}
              />
            );
          })}

        {/* Bulbs back-to-front */}
        {drawOrder.map(({ bulb, state, top, bot }) => {
          const isSel = selection.has(bulb.id);
          const isOn = state.bright > 0.02;
          const opacity = state.bright;
          const r = BULB_R_BASE * bot.scale;

          return (
            <g
              key={bulb.id}
              className="bulb-row"
              onMouseDown={(e) => handleBulbDown(e, bulb)}
            >
              {/* Cord */}
              <line
                x1={top.x}
                y1={top.y}
                x2={bot.x}
                y2={bot.y - r + 2}
                stroke={isSel ? 'var(--select)' : 'var(--ink-2)'}
                strokeWidth={isSel ? 1.4 : 0.7}
                opacity={isSel ? 1 : 0.5}
              />
              {/* Cap */}
              <rect
                x={bot.x - r * 0.25}
                y={bot.y - r - 1}
                width={r * 0.5}
                height={r * 0.4}
                rx={1}
                fill="var(--ink-2)"
                opacity={0.65}
              />

              {/* Glow halo */}
              {isOn && renderStyle !== 'wire' && (
                <circle
                  cx={bot.x}
                  cy={bot.y}
                  r={r * (1.7 + opacity * 0.8)}
                  fill="oklch(0.85 0.14 75)"
                  opacity={opacity * 0.2}
                  filter="url(#big-glow)"
                  style={{ pointerEvents: 'none' }}
                />
              )}

              {/* Bulb body */}
              {renderStyle === 'wire' ? (
                <circle
                  cx={bot.x}
                  cy={bot.y}
                  r={r}
                  fill="var(--paper)"
                  stroke={isSel ? 'var(--select)' : (isOn ? 'var(--accent-deep)' : 'var(--ink-3)')}
                  strokeWidth={isSel ? 2 : 1}
                />
              ) : (
                <>
                  <circle
                    cx={bot.x}
                    cy={bot.y}
                    r={r}
                    fill={isOn ? 'url(#bulb-glow)' : 'url(#bulb-off)'}
                    opacity={isOn ? Math.max(0.4, opacity) : 1}
                  />
                  <circle
                    cx={bot.x}
                    cy={bot.y}
                    r={r}
                    fill="none"
                    stroke={isSel ? 'var(--select)' : 'rgba(0,0,0,0.18)'}
                    strokeWidth={isSel ? 2 : 0.5}
                  />
                  {renderStyle === 'glow' && (
                    <ellipse
                      cx={bot.x - r * 0.35}
                      cy={bot.y - r * 0.45}
                      rx={r * 0.32}
                      ry={r * 0.22}
                      fill="rgba(255,255,255,0.55)"
                      style={{ pointerEvents: 'none' }}
                    />
                  )}
                </>
              )}

              {isSel && (
                <circle
                  cx={bot.x}
                  cy={bot.y}
                  r={r + 6}
                  fill="none"
                  stroke="var(--select)"
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  style={{ pointerEvents: 'none' }}
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

