/* Brandelier — main app */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CameraWidget } from './components/CameraWidget';
import { Chandelier } from './components/Chandelier';
import { GroupsPanel } from './components/GroupsPanel';
import { Inspector } from './components/Inspector';
import { WavePanel } from './components/WavePanel';
import { useOrbitDrag } from './hooks/useOrbitDrag.ts';
import { BULBS } from './topology';
import type { BulbId, BulbState, BulbStatusMap, Camera, DragDelta, Group, Mode, RenderStyle, Wave } from './types';

const RENDER_STYLE: RenderStyle = 'glow';
const SHOW_HELP = true;

function App() {
  // bulbState: { id: { pos, bright } } pos: 0..1 (0=high/short, 1=low/long), bright: 0..1
  const initialState = useMemo<BulbState>(() => {
    const s: BulbState = {};
    BULBS.forEach((b) => {
      // Initial chandelier silhouette: outer bulbs hang lower, inner higher.
      // Use slot distance from center to compute drop distance, plus tiny variance.
      const dist = Math.sqrt(b.x3 * b.x3 + b.z3 * b.z3);
      // pos: 0 = high (short cord), 1 = low (long cord). Outer ring drops more.
      const pos = 0.18 + (dist / 2.5) * 0.45;
      s[b.id] = { pos: Math.max(0, Math.min(1, pos)), bright: 0.0 };
    });
    return s;
  }, []);

  const [bulbState, setBulbState] = useState<BulbState>(initialState);
  const [bulbStatus, setBulbStatus] = useState<BulbStatusMap>({});
  const [sceneReady, setSceneReady] = useState(false);
  const [selection, setSelection] = useState<Set<BulbId>>(new Set());
  const [history, setHistory] = useState<BulbState[]>([]);
  const [future, setFuture] = useState<BulbState[]>([]);
  const [mode, setMode] = useState<Mode>('manual');
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([
    { id: 'g1', name: 'Inner ring', ids: BULBS.filter((b) => b.ring === 1).map((b) => b.id) },
    { id: 'g2', name: 'Outer ring', ids: BULBS.filter((b) => b.ring === 2).map((b) => b.id) },
    { id: 'g3', name: 'Center only', ids: ['c'] },
  ]);

  const [wave, setWave] = useState<Wave>({ pattern: 'sine', amp: 0.4, speed: 1.0, phase: 0.5 });
  const [isPlaying, setIsPlaying] = useState(false);
  const [camera, setCamera] = useState<Camera>({ yaw: -0.35, elevation: 0.28 });
  const [orbiting, setOrbiting] = useState(false);
  const orbitDrag = useOrbitDrag(camera, setCamera, {
    yawSensitivity: 0.006,
    tiltSensitivity: 0.005,
    onOrbitingChange: setOrbiting,
  });

  // Mirror of bulbState in a ref so handlers (e.g. drag-end) can read the
  // very latest state synchronously, without depending on closure capture
  // racing with React's render commits.
  const bulbStateRef = useRef(bulbState);
  useEffect(() => {
    bulbStateRef.current = bulbState;
  }, [bulbState]);

  // Poll /api/status on mount (sync pos) then every second (errors / zeroing)
  const initialSyncDone = useRef(false);
  useEffect(() => {
    const fetchStatus = () => {
      fetch('/api/status')
        .then((r) => r.json() as Promise<BulbStatusMap>)
        .then((data) => {
          setBulbStatus(data);
          if (!initialSyncDone.current) {
            initialSyncDone.current = true;
            setBulbState((cur) => {
              const next = { ...cur };
              Object.entries(data).forEach(([id, s]) => {
                if (id in next) next[id] = { ...next[id], pos: s.pos };
              });
              return next;
            });
            setSceneReady(true);
          }
        })
        .catch((err) => console.error('Failed to fetch status:', err));
    };
    fetchStatus();
    const id = setInterval(fetchStatus, 1000);
    return () => clearInterval(id);
  }, []);

  // Push state to history before mutation
  const pushHistory = useCallback(() => {
    setHistory((h) => [...h.slice(-49), bulbState]);
    setFuture([]);
  }, [bulbState]);

  const undo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [bulbState, ...f].slice(0, 50));
    setBulbState(prev);
  };
  const redo = () => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setHistory((h) => [...h, bulbState]);
    setBulbState(next);
  };

  // Selection
  const handleSelect = (id: BulbId, additive: boolean) => {
    // Clicking a bulb that's already in the selection (without a modifier)
    // preserves the selection — otherwise the user can't grab a group from
    // a member without collapsing it down to that one bulb.
    if (!additive && selection.has(id)) return;
    setSelection((cur) => {
      const next = new Set<BulbId>(additive ? cur : []);
      if (additive && cur.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setActiveGroup(null);
  };
  const handleClear = () => {
    setSelection(new Set());
    setActiveGroup(null);
  };
  const selectAll = () => setSelection(new Set(BULBS.map((b) => b.id)));

  // Drag
  const dragSnapshotRef = useRef<BulbState | null>(null);
  const handleDrag = ({ dx, dy, axis }: DragDelta) => {
    if (selection.size === 0) return;
    // Until the drag picks an axis the user hasn't actually moved enough
    // to apply anything; skip so we don't snapshot/push history for a
    // jitter that's really just a click.
    if (axis === null) return;
    if (!dragSnapshotRef.current) {
      dragSnapshotRef.current = bulbState;
      pushHistory();
    }
    setBulbState((cur) => {
      const next = { ...cur };
      selection.forEach((id) => {
        const s = next[id];
        if (s === undefined) return;
        if (axis === 'y') {
          // Drag up reduces pos (raises bulb), down increases
          const newPos = Math.max(0, Math.min(1, s.pos + dy / 320));
          next[id] = { ...s, pos: newPos };
        } else if (axis === 'x') {
          const newBright = Math.max(0, Math.min(1, s.bright + dx / 280));
          next[id] = { ...s, bright: newBright };
        }
      });
      return next;
    });
  };

  const handleDragEnd = () => {
    // Only POST if the drag actually moved bulbs — a bare click sets up a
    // potential drag but never assigns the snapshot, so we skip.
    const moved = dragSnapshotRef.current !== null;
    dragSnapshotRef.current = null;
    if (!moved) return;
    void fetch('/api/bulbs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bulbStateRef.current),
    }).catch((err) => {
      console.error('Failed to push bulb state:', err);
    });
  };

  // Groups
  const activateGroup = (gid: string) => {
    const g = groups.find((x) => x.id === gid);
    if (!g) return;
    setSelection(new Set(g.ids));
    setActiveGroup(gid);
  };
  const createGroup = (name: string) => {
    if (selection.size === 0) return;
    const id = 'g' + Date.now();
    setGroups((gs) => [...gs, { id, name, ids: [...selection] }]);
    setActiveGroup(id);
  };

  // Wave animation
  const waveStartRef = useRef(0);
  useEffect(() => {
    if (!isPlaying) return;
    waveStartRef.current = performance.now();
    const baseSnapshot = { ...bulbState };
    let raf = 0;
    const tick = () => {
      const t = (performance.now() - waveStartRef.current) / 1000;
      setBulbState((cur) => {
        const next = { ...cur };
        const targets = selection.size > 0 ? [...selection] : BULBS.map((b) => b.id);
        targets.forEach((id) => {
          const b = BULBS.find((x) => x.id === id);
          if (!b) return;
          const base = baseSnapshot[id] || { pos: 0.5, bright: 0.7 };
          const phaseOffset =
            wave.pattern === 'ripple'
              ? Math.sqrt(b.x3 * b.x3 + b.z3 * b.z3) * wave.phase * 2
              : b.x3 * wave.phase * 1.2;
          const omega = 2 * Math.PI * wave.speed * 0.4;
          let v = 0;
          if (wave.pattern === 'sine' || wave.pattern === 'ripple') {
            v = Math.sin(omega * t - phaseOffset);
          } else if (wave.pattern === 'breath') {
            v = (Math.sin(omega * t * 0.6) + 1) / 2 - 0.5;
            v *= 2;
          } else if (wave.pattern === 'chase') {
            const pos = ((omega * t) / Math.PI / 2 - phaseOffset / Math.PI / 2) % 1;
            v = Math.cos(pos * 2 * Math.PI);
          }
          const offset = v * wave.amp * 0.4;
          next[id] = {
            pos: Math.max(0, Math.min(1, base.pos + offset)),
            bright: base.bright,
          };
        });
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, wave, selection, bulbState]);

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        selectAll();
      } else if (e.key === 'Escape') {
        handleClear();
      } else if (e.key === ' ' && mode === 'wave') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setBrightForSelection = (b: number) => {
    pushHistory();
    setBulbState((cur) => {
      const next = { ...cur };
      selection.forEach((id) => {
        next[id] = { ...next[id], bright: b };
      });
      return next;
    });
    const payload: Record<string, { pos: number; bright: number }> = {};
    selection.forEach((id) => {
      const cur = bulbStateRef.current[id];
      if (cur) payload[id] = { ...cur, bright: b };
    });
    void fetch('/api/bulbs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((err) => console.error('Failed to push brightness:', err));
  };

  return (
    <div className="app">
      {/* Top bar */}
      <header className="topbar">
        <div className="brand">
          <span className="dot"></span>
          Brandelier
          <em>kinetic chandelier · console</em>
        </div>

        <nav className="modebar" role="tablist">
          <button role="tab" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>
            Manual
          </button>
          <button role="tab" aria-pressed={mode === 'wave'} onClick={() => setMode('wave')}>
            Wave
          </button>
          <button role="tab" aria-pressed={mode === 'precise'} onClick={() => setMode('precise')}>
            Precise
          </button>
        </nav>

        <div className="topbar-right">
          <span className="broadcast">
            <span className="live"></span>
            Broadcasting · 19 fixtures
          </span>
          <button
            className="iconbtn"
            onClick={undo}
            disabled={history.length === 0}
            title="Undo (⌘Z)"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 8 L 6 5 M3 8 L 6 11 M3 8 H 11 A 2 2 0 0 1 13 10 V 11" />
            </svg>
          </button>
          <button
            className="iconbtn"
            onClick={redo}
            disabled={future.length === 0}
            title="Redo (⌘⇧Z)"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M13 8 L 10 5 M13 8 L 10 11 M13 8 H 5 A 2 2 0 0 0 3 10 V 11" />
            </svg>
          </button>
        </div>
      </header>

      {/* Stage */}
      <main
        className="stage"
        style={{
          cursor: orbiting ? 'grabbing' : 'default',
          opacity: sceneReady ? 1 : 0,
          transition: 'opacity 0.15s ease',
        }}
        onMouseDown={(e) => {
          if (e.button === 2 || (e.shiftKey && e.target === e.currentTarget) || e.altKey) {
            orbitDrag(e);
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="stage-meta">
          <span className="l">Selection</span>
          <span className="v">{selection.size} of 19 fixtures</span>
        </div>

        <Chandelier
          bulbState={bulbState}
          bulbStatus={bulbStatus}
          selection={selection}
          onSelect={handleSelect}
          onClear={handleClear}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          renderStyle={RENDER_STYLE}
          camera={camera}
        />

        {/* Camera widget */}
        <CameraWidget camera={camera} setCamera={setCamera} />

        {SHOW_HELP && (
          <div className="stage-help">
            <span>
              <kbd>drag ↕</kbd> height
            </span>
            <span>
              <kbd>drag ↔</kbd> brightness
            </span>
            <span>
              <kbd>shift</kbd>+click multi
            </span>
            <span>
              <kbd>alt</kbd>+drag orbit
            </span>
            <span>
              <kbd>esc</kbd> clear
            </span>
          </div>
        )}
      </main>

      {/* Right rail */}
      <aside className="rail">
        <section className="rail-section">
          <div className="rail-h">
            <h3>Selection</h3>
            <span className="num">{selection.size} / 19</span>
          </div>
          <Inspector
            selectedIds={selection}
            bulbState={bulbState}
            onClear={handleClear}
            onZero={() => {
              const payload: Record<string, { pos: number; bright: number }> = {};
              selection.forEach((id) => {
                payload[id] = bulbState[id] ?? { pos: 0, bright: 0 };
              });
              void fetch('/api/zero', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              }).catch((err) => {
                console.error('Failed to send zero command:', err);
              });
            }}
          />
          {selection.size > 0 && (
            <div className="action-row">
              <button className="btn" onClick={() => setBrightForSelection(0)}>
                Off
              </button>
              <button className="btn" onClick={() => setBrightForSelection(0.1)}>
                10%
              </button>
              <button className="btn" onClick={() => setBrightForSelection(0.15)}>
                15%
              </button>
              <button className="btn" onClick={() => setBrightForSelection(0.25)}>
                25%
              </button>
              <button className="btn" onClick={() => setBrightForSelection(0.5)}>
                50%
              </button>
              <button className="btn primary" onClick={() => setBrightForSelection(1)}>
                Full
              </button>
            </div>
          )}
        </section>

        <section className="rail-section">
          <GroupsPanel
            groups={groups}
            activeGroup={activeGroup}
            onActivate={activateGroup}
            onCreate={createGroup}
            currentSelectionCount={selection.size}
          />
        </section>

        {mode === 'wave' && (
          <section className="rail-section">
            <WavePanel
              wave={wave}
              onWave={setWave}
              isPlaying={isPlaying}
              onPlay={() => {
                setMode('wave');
                setIsPlaying(true);
              }}
              onStop={() => setIsPlaying(false)}
            />
          </section>
        )}
      </aside>

      {/* Bottom action bar */}
      <footer className="actionbar">
        <div className="group">
          <button className="transport-btn" onClick={selectAll}>
            Select all
          </button>
          <button className="transport-btn" onClick={handleClear}>
            Clear
          </button>
          <div className="divider"></div>
          <button className="transport-btn">Save config</button>
          <button className="transport-btn">Load</button>
          <button className="transport-btn">Schedule</button>
        </div>

        <div className="group">
          <span className="connection">
            <span className="dot"></span>
            Live · ws://chandelier.local
          </span>
          <div className="divider"></div>
          {isPlaying ? (
            <button className="transport-btn stop" onClick={() => setIsPlaying(false)}>
              <svg viewBox="0 0 12 12" fill="currentColor">
                <rect x="2" y="2" width="8" height="8" rx="1" />
              </svg>
              Stop
            </button>
          ) : (
            <button
              className="transport-btn primary"
              onClick={() => {
                setMode('wave');
                setIsPlaying(true);
              }}
            >
              <svg viewBox="0 0 12 12" fill="currentColor">
                <path d="M2 1 L 11 6 L 2 11 Z" />
              </svg>
              Run wave
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

export default App;
