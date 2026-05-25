/* Brandelier — main app */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CameraWidget } from './components/CameraWidget';
import { Chandelier } from './components/Chandelier';
import { GroupsPanel } from './components/GroupsPanel';
import { Inspector } from './components/Inspector';
import { PresetsPanel } from './components/PresetsPanel';
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
  const [presets, setPresets] = useState<string[]>([]);
  const [previewingPreset, setPreviewingPreset] = useState<string | null>(null);
  const previewSnapshotRef = useRef<BulbState | null>(null);
  const [history, setHistory] = useState<BulbState[]>([]);
  const [future, setFuture] = useState<BulbState[]>([]);
  const [mode, setMode] = useState<Mode>('manual');
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([
    { id: 'g0', name: 'All', ids: BULBS.map((b) => b.id) },
    { id: 'g1', name: 'Outer ring', ids: BULBS.filter((b) => b.ring === 2).map((b) => b.id) },
    { id: 'g2', name: 'Inner ring', ids: BULBS.filter((b) => b.ring === 1).map((b) => b.id) },
    { id: 'g3', name: 'Center only', ids: ['c'] },
  ]);

  const [maxLength, setMaxLength] = useState(37);
  const maxLengthSynced = useRef(false);
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json() as Promise<{ max_length_in: number }>)
      .then((data) => {
        maxLengthSynced.current = true;
        setMaxLength(data.max_length_in);
      })
      .catch(console.error);
  }, []);
  useEffect(() => {
    if (!maxLengthSynced.current) return;
    const id = setTimeout(() => {
      void fetch('/api/settings/max-length', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inches: maxLength }),
      }).catch(console.error);
    }, 300);
    return () => clearTimeout(id);
  }, [maxLength]);
  const [wave, setWave] = useState<Wave>({ pattern: 'sine', target: 'extension', amp: 0.1, speed: 1.0, wavelength: 1.0, direction: 0, spinPeriod: 30 });
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

  const pushBulbs = (state: BulbState) => {
    void fetch('/api/bulbs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch((err) => console.error('Failed to push bulb state:', err));
  };

  // Presets
  const fetchPresets = () => {
    fetch('/api/presets')
      .then((r) => r.json() as Promise<string[]>)
      .then(setPresets)
      .catch(console.error);
  };

  useEffect(() => {
    if (mode === 'presets') fetchPresets();
    if (mode !== 'presets' && previewSnapshotRef.current) {
      setBulbState(previewSnapshotRef.current);
      previewSnapshotRef.current = null;
      setPreviewingPreset(null);
    }
  }, [mode]);

  const previewPreset = (name: string) => {
    if (!previewSnapshotRef.current) {
      previewSnapshotRef.current = bulbStateRef.current;
    }
    fetch(`/api/presets/${encodeURIComponent(name)}`)
      .then((r) => r.json() as Promise<BulbState>)
      .then((state) => {
        setBulbState(state);
        setPreviewingPreset(name);
      })
      .catch(console.error);
  };

  const cancelPreview = () => {
    if (previewSnapshotRef.current) {
      setBulbState(previewSnapshotRef.current);
      previewSnapshotRef.current = null;
    }
    setPreviewingPreset(null);
  };

  const loadPreset = () => {
    const state = bulbStateRef.current;
    const snapshot = previewSnapshotRef.current;
    previewSnapshotRef.current = null;
    setPreviewingPreset(null);
    if (snapshot) {
      setHistory((h) => [...h.slice(-49), snapshot]);
      setFuture([]);
    }
    pushBulbs(state);
  };

  const savePreset = (name: string) => {
    void fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, state: bulbStateRef.current }),
    })
      .then(() => fetchPresets())
      .catch(console.error);
  };

  const deletePreset = (name: string) => {
    void fetch(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(() => {
        cancelPreview();
        fetchPresets();
      })
      .catch(console.error);
  };

  const undo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [bulbState, ...f].slice(0, 50));
    setBulbState(prev);
    pushBulbs(prev);
  };
  const redo = () => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setHistory((h) => [...h, bulbState]);
    setBulbState(next);
    pushBulbs(next);
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
  const handleDrag = ({ dx, dy, axis, ctrl }: DragDelta) => {
    if (selection.size === 0) return;
    // Until the drag picks an axis the user hasn't actually moved enough
    // to apply anything; skip so we don't snapshot/push history for a
    // jitter that's really just a click.
    if (axis === null) return;
    if (!dragSnapshotRef.current) {
      dragSnapshotRef.current = bulbState;
      pushHistory();
    }
    const scale = ctrl ? 6 : 1;
    setBulbState((cur) => {
      const next = { ...cur };
      selection.forEach((id) => {
        const s = next[id];
        if (s === undefined) return;
        if (axis === 'y') {
          // Drag up reduces pos (raises bulb), down increases
          const newPos = Math.max(0, Math.min(1, s.pos + dy / (320 * scale)));
          next[id] = { ...s, pos: newPos };
        } else if (axis === 'x') {
          const newBright = Math.max(0, Math.min(1, s.bright + dx / (280 * scale)));
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
    let lastPush = 0;
    let waveController: AbortController | null = null;
    // Per-ring ordered lists for spin interpolation (ring 0 excluded).
    // BULBS is already in ringIndex order so no additional sorting is needed.
    const targets0 = new Set(selection.size > 0 ? [...selection] : BULBS.map((b) => b.id));
    const spinRings = new Map<number, string[]>();
    BULBS.forEach((b) => {
      if (b.ring === 0 || !targets0.has(b.id)) return;
      const list = spinRings.get(b.ring) ?? [];
      list.push(b.id);
      spinRings.set(b.ring, list);
    });

    const tick = () => {
      const now = performance.now();
      const t = (now - waveStartRef.current) / 1000;
      const next = { ...bulbStateRef.current };
      const targets = selection.size > 0 ? [...selection] : BULBS.map((b) => b.id);

      if (wave.pattern === 'spin') {
        const offset = ((t / wave.spinPeriod) % 1);
        spinRings.forEach((ring) => {
          const n = ring.length;
          const shift = offset * n;
          ring.forEach((id, i) => {
            const src = (i + shift) % n;
            const lo = Math.floor(src) % n;
            const hi = (lo + 1) % n;
            const frac = src % 1;
            const blo = baseSnapshot[ring[lo]] ?? { pos: 0.5, bright: 0 };
            const bhi = baseSnapshot[ring[hi]] ?? { pos: 0.5, bright: 0 };
            next[id] = {
              pos: blo.pos + frac * (bhi.pos - blo.pos),
              bright: blo.bright + frac * (bhi.bright - blo.bright),
            };
          });
        });
      } else {
        targets.forEach((id) => {
          const b = BULBS.find((x) => x.id === id);
          if (!b) return;
          const base = baseSnapshot[id] || { pos: 0.5, bright: 0.7 };
          const dir = (wave.direction * Math.PI) / 180;
          const k = (2 * Math.PI) / wave.wavelength / 5;
          const phaseOffset =
            wave.pattern === 'ripple'
              ? Math.sqrt(b.x3 * b.x3 + b.z3 * b.z3) * k
              : (b.x3 * Math.cos(dir) + b.z3 * Math.sin(dir)) * k;
          const omega = 2 * Math.PI * wave.speed * 0.04;
          const v = Math.sin(omega * t - phaseOffset);
          const offset = v * wave.amp * 0.4;
          if (wave.target === 'brightness') {
            next[id] = { pos: base.pos, bright: Math.max(0, Math.min(1, base.bright + offset)) };
          } else {
            next[id] = { pos: Math.max(0, Math.min(1, base.pos + offset)), bright: base.bright };
          }
        });
      }
      setBulbState(next);
      if (now - lastPush >= 1000 / 30) {
        lastPush = now;
        waveController?.abort();
        waveController = new AbortController();
        void fetch('/api/bulbs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
          signal: waveController.signal,
        }).catch((err: Error) => {
          if (err.name !== 'AbortError') console.error('Failed to push bulb state:', err);
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, wave]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <button role="tab" aria-pressed={mode === 'presets'} onClick={() => setMode('presets')}>
            Presets
          </button>
          <button role="tab" aria-pressed={mode === 'wave'} onClick={() => setMode('wave')}>
            Wave
          </button>
          <button role="tab" aria-pressed={mode === 'schedule'} onClick={() => setMode('schedule')}>
            Schedule
          </button>
          <button role="tab" aria-pressed={mode === 'settings'} onClick={() => setMode('settings')}>
            Settings
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
        onClick={() => { if (previewingPreset) cancelPreview(); }}
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
              <kbd>ctrl</kbd>+precise drag
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
        {mode === 'settings' && (
          <section className="rail-section">
            <div className="rail-h">
              <h3>Settings</h3>
            </div>
            <div className="settings-row">
              <label className="settings-label">
                Max cord length
                <span className="settings-value">{maxLength} in</span>
              </label>
              <input
                type="range"
                min={5}
                max={100}
                value={maxLength}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  const scale = maxLength / next;
                  setBulbState((cur) => {
                    const s: typeof cur = {};
                    for (const id in cur) {
                      s[id] = { ...cur[id], pos: Math.min(1, cur[id].pos * scale) };
                    }
                    return s;
                  });
                  setMaxLength(next);
                }}
                className="settings-slider"
              />
              <div className="settings-range-labels">
                <span>5 in</span>
                <span>100 in</span>
              </div>
            </div>
          </section>
        )}

        {mode !== 'settings' && (
          <>
            <section className="rail-section">
              <div className="rail-h">
                <h3>Selection</h3>
                <span className="num">{selection.size} / 19</span>
              </div>
              <Inspector
                selectedIds={selection}
                bulbState={bulbState}
                maxLength={maxLength}
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
                  <button className="btn" onClick={() => setBrightForSelection(0.05)}>
                    5%
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
                  <button className="btn" onClick={() => setBrightForSelection(1)}>
                    Full
                  </button>
                </div>
              )}
            </section>

            {mode !== 'wave' && (
              <section className="rail-section">
                <GroupsPanel
                  groups={groups}
                  activeGroup={activeGroup}
                  onActivate={activateGroup}
                  onCreate={createGroup}
                  currentSelectionCount={selection.size}
                />
              </section>
            )}

            {mode === 'presets' && (
              <section className="rail-section">
                <PresetsPanel
                  presets={presets}
                  previewing={previewingPreset}
                  onPreview={previewPreset}
                  onCancelPreview={cancelPreview}
                  onLoad={loadPreset}
                  onSave={savePreset}
                  onDelete={deletePreset}
                />
              </section>
            )}

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
          </>
        )}
      </aside>


    </div>
  );
}

export default App;
