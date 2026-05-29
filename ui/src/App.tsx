/* Brandelier — main app */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CameraWidget } from './components/CameraWidget';
import { Chandelier } from './components/Chandelier';
import { CollapsibleSection } from './components/CollapsibleSection';
import { GroupsPanel } from './components/GroupsPanel';
import { Inspector } from './components/Inspector';
import { PresetsPanel } from './components/PresetsPanel';
import { WavePanel } from './components/WavePanel';
import { useOrbitDrag } from './hooks/useOrbitDrag.ts';
import { BULBS } from './topology';
import type { BulbId, BulbState, BulbStatusMap, Camera, DragDelta, Group, Mode, PresetKind, RenderStyle, Wave } from './types';

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
  const [positionPresets, setPositionPresets] = useState<string[]>([]);
  const [brightnessPresets, setBrightnessPresets] = useState<string[]>([]);
  const [wavePresets, setWavePresets] = useState<string[]>([]);
  const [previewingPreset, setPreviewingPreset] = useState<{ name: string; kind: PresetKind } | null>(null);
  const previewSnapshotRef = useRef<BulbState | null>(null);
  const [history, setHistory] = useState<BulbState[]>([]);
  const [future, setFuture] = useState<BulbState[]>([]);
  const [mode, setMode] = useState<Mode>('presets');
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([
    { id: 'g0', name: 'All', ids: BULBS.map((b) => b.id), builtin: true },
    { id: 'g1', name: 'Outer ring', ids: BULBS.filter((b) => b.ring === 2).map((b) => b.id), builtin: true },
    { id: 'g2', name: 'Inner ring', ids: BULBS.filter((b) => b.ring === 1).map((b) => b.id), builtin: true },
    { id: 'g3', name: 'Center only', ids: ['c'], builtin: true },
  ]);

  const groupsSynced = useRef(false);
  useEffect(() => {
    fetch('/api/groups')
      .then((r) => r.json() as Promise<Group[]>)
      .then((data) => {
        groupsSynced.current = true;
        if (Array.isArray(data) && data.length > 0) setGroups(data);
      })
      .catch(() => { groupsSynced.current = true; });
  }, []);
  useEffect(() => {
    if (!groupsSynced.current) return;
    const id = setTimeout(() => {
      void fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(groups),
      }).catch(console.error);
    }, 300);
    return () => clearTimeout(id);
  }, [groups]);

  const [disabledAll, setDisabledAll] = useState(false);
  const prevDisabledAllRef = useRef(false);

  const [dimmer, setDimmer] = useState(1.0);
  const dimmerRef = useRef(1.0);

  const [maxLength, setMaxLength] = useState(37);
  const maxLengthSynced = useRef(false);

  const [startupBrightness, setStartupBrightness] = useState(1.0);
  const [kpPos, setKpPos] = useState(3.0);
  const [maxIps, setMaxIps] = useState(1.2);

  const loadSettings = useCallback(() => {
    fetch('/api/settings')
      .then((r) => r.json() as Promise<{ max_length_in: number; dimmer?: number; startup_brightness?: number; kp_pos?: number; max_ips?: number }>)
      .then((data) => {
        maxLengthSynced.current = true;
        setMaxLength(data.max_length_in);
        if (data.dimmer !== undefined) {
          dimmerRef.current = data.dimmer;
          setDimmer(data.dimmer);
        }
        if (data.startup_brightness !== undefined) {
          setStartupBrightness(data.startup_brightness);
        }
        if (data.kp_pos !== undefined) setKpPos(data.kp_pos);
        if (data.max_ips !== undefined) setMaxIps(data.max_ips);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) loadSettings();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [loadSettings]);

  useEffect(() => {
    loadSettings();
    fetch('/api/wave')
      .then((r) => r.json() as Promise<{
        running: boolean;
        startedAt?: number;
        config?: {
          waves: Wave[];
          posPreset?: string | null;
          brightPreset?: string | null;
          basePos?: Record<string, number>;
          baseBright?: Record<string, number>;
        };
      }>)
      .then(({ running, startedAt, config }) => {
        if (running && startedAt !== undefined && config) {
          waveServerStartRef.current = startedAt;
          setWaves(config.waves);
          setWavePosPresetName(config.posPreset ?? null);
          setWaveBrightPresetName(config.brightPreset ?? null);
          // Seed bulbState from the stored base snapshot so the wave animation's
          // fallback path uses the correct values immediately. We also write
          // bulbStateRef directly so the ref is current before the first tick.
          if (config.basePos || config.baseBright) {
            const restored: BulbState = {};
            BULBS.forEach((b) => {
              restored[b.id] = {
                pos: config.basePos?.[b.id] ?? 0.5,
                bright: config.baseBright?.[b.id] ?? 0,
              };
            });
            bulbStateRef.current = restored;
            setBulbState(restored);
          }
          setIsPlaying(true);
          setMode('wave');
        }
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
  const defaultWave: Wave = { pattern: 'sine', target: 'extension', amp: 0.1, speed: 1.0, wavelength: 1.0, direction: 0, spinPeriod: 30, spinReverse: false, groupId: 'g0' };
  const [waves, setWaves] = useState<Wave[]>([defaultWave]);
  const [wavePosPresetName, setWavePosPresetName] = useState<string | null>(null);
  const [waveBrightPresetName, setWaveBrightPresetName] = useState<string | null>(null);
  const wavePosSnapshotRef = useRef<Record<string, { pos: number }> | null>(null);
  const waveBrightSnapshotRef = useRef<Record<string, { bright: number }> | null>(null);
  useEffect(() => {
    if (!wavePosPresetName) { wavePosSnapshotRef.current = null; return; }
    fetch(`/api/presets/position/${encodeURIComponent(wavePosPresetName)}`)
      .then((r) => r.json() as Promise<Record<string, { pos: number }>>)
      .then((data) => { wavePosSnapshotRef.current = data; })
      .catch(() => { wavePosSnapshotRef.current = null; });
  }, [wavePosPresetName]);
  useEffect(() => {
    if (!waveBrightPresetName) { waveBrightSnapshotRef.current = null; return; }
    fetch(`/api/presets/brightness/${encodeURIComponent(waveBrightPresetName)}`)
      .then((r) => r.json() as Promise<Record<string, { bright: number }>>)
      .then((data) => { waveBrightSnapshotRef.current = data; })
      .catch(() => { waveBrightSnapshotRef.current = null; });
  }, [waveBrightPresetName]);
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
  const dimmerAbortRef = useRef<AbortController | null>(null);

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
                if (id in next) next[id] = { ...next[id], pos: s.pos, bright: s.bright };
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

  // Poll disable-all state; on re-enable, re-sync wave clock and push static state
  useEffect(() => {
    const fetchDisableAll = () => {
      fetch('/api/disable-all')
        .then((r) => r.json() as Promise<{ disabled: boolean }>)
        .then(({ disabled }) => {
          const wasDisabled = prevDisabledAllRef.current;
          prevDisabledAllRef.current = disabled;
          setDisabledAll(disabled);
          if (wasDisabled && !disabled) {
            // Re-sync wave clock from server
            fetch('/api/wave')
              .then((r) => r.json() as Promise<{ running: boolean; startedAt?: number }>)
              .then(({ running, startedAt }) => {
                if (running && startedAt !== undefined) {
                  waveServerStartRef.current = startedAt;
                  setIsPlaying(true);
                } else {
                  setIsPlaying(false);
                  pushBulbs(bulbStateRef.current);
                }
              })
              .catch(console.error);
          }
        })
        .catch(console.error);
    };
    fetchDisableAll();
    const id = setInterval(fetchDisableAll, 1000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRestoreFromDisable = () => {
    setDisabledAll(false);
    prevDisabledAllRef.current = false;
    void fetch('/api/disable-all', { method: 'POST' })
      .then(() => {
        fetch('/api/wave')
          .then((r) => r.json() as Promise<{ running: boolean; startedAt?: number }>)
          .then(({ running, startedAt }) => {
            if (running && startedAt !== undefined) {
              waveServerStartRef.current = startedAt;
              setIsPlaying(true);
            } else {
              setIsPlaying(false);
              pushBulbs(bulbStateRef.current);
            }
          })
          .catch(console.error);
      })
      .catch(console.error);
  };

  // Push state to history before mutation
  const pushHistory = useCallback(() => {
    setHistory((h) => [...h.slice(-49), bulbState]);
    setFuture([]);
  }, [bulbState]);

  useEffect(() => { dimmerRef.current = dimmer; }, [dimmer]);

  const dimState = (state: BulbState): BulbState => {
    const d = dimmerRef.current;
    if (d === 1) return state;
    const out: BulbState = {};
    for (const id in state) out[id] = { ...state[id], bright: state[id].bright * d };
    return out;
  };

  const pushBulbs = (state: BulbState) => {
    void fetch('/api/bulbs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dimState(state)),
    }).catch((err) => console.error('Failed to push bulb state:', err));
  };

  // Presets
  const fetchPositionPresets = () => {
    fetch('/api/presets/position')
      .then((r) => r.json() as Promise<string[]>)
      .then(setPositionPresets)
      .catch(console.error);
  };
  const fetchBrightnessPresets = () => {
    fetch('/api/presets/brightness')
      .then((r) => r.json() as Promise<string[]>)
      .then(setBrightnessPresets)
      .catch(console.error);
  };
  const fetchWavePresets = () => {
    fetch('/api/presets/wave')
      .then((r) => r.json() as Promise<string[]>)
      .then(setWavePresets)
      .catch(console.error);
  };

  useEffect(() => {
    if (mode === 'presets' || mode === 'wave') {
      fetchPositionPresets();
      fetchBrightnessPresets();
    }
    if (mode === 'wave') {
      fetchWavePresets();
    }
    if (mode !== 'presets' && previewSnapshotRef.current) {
      setBulbState(previewSnapshotRef.current);
      previewSnapshotRef.current = null;
      setPreviewingPreset(null);
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const previewPositionPreset = (name: string) => {
    if (!previewSnapshotRef.current) {
      previewSnapshotRef.current = bulbStateRef.current;
    }
    fetch(`/api/presets/position/${encodeURIComponent(name)}`)
      .then((r) => r.json() as Promise<Record<string, { pos: number }>>)
      .then((data) => {
        setBulbState((cur) => {
          const next = { ...cur };
          Object.entries(data).forEach(([id, { pos }]) => {
            if (id in next) next[id] = { ...next[id], pos };
          });
          return next;
        });
        setPreviewingPreset({ name, kind: 'position' });
      })
      .catch(console.error);
  };

  const previewBrightnessPreset = (name: string) => {
    if (!previewSnapshotRef.current) {
      previewSnapshotRef.current = bulbStateRef.current;
    }
    fetch(`/api/presets/brightness/${encodeURIComponent(name)}`)
      .then((r) => r.json() as Promise<Record<string, { bright: number }>>)
      .then((data) => {
        setBulbState((cur) => {
          const next = { ...cur };
          Object.entries(data).forEach(([id, { bright }]) => {
            if (id in next) next[id] = { ...next[id], bright };
          });
          return next;
        });
        setPreviewingPreset({ name, kind: 'brightness' });
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

  const savePositionPreset = (name: string) => {
    const state: Record<string, { pos: number }> = {};
    Object.entries(bulbStateRef.current).forEach(([id, s]) => { state[id] = { pos: s.pos }; });
    void fetch('/api/presets/position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, state }),
    }).then(fetchPositionPresets).catch(console.error);
  };

  const saveBrightnessPreset = (name: string) => {
    const state: Record<string, { bright: number }> = {};
    Object.entries(bulbStateRef.current).forEach(([id, s]) => { state[id] = { bright: s.bright }; });
    void fetch('/api/presets/brightness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, state }),
    }).then(fetchBrightnessPresets).catch(console.error);
  };

  const deletePositionPreset = (name: string) => {
    void fetch(`/api/presets/position/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(() => { cancelPreview(); fetchPositionPresets(); })
      .catch(console.error);
  };

  const deleteBrightnessPreset = (name: string) => {
    void fetch(`/api/presets/brightness/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(() => { cancelPreview(); fetchBrightnessPresets(); })
      .catch(console.error);
  };

  const saveWavePreset = (name: string) => {
    void fetch('/api/presets/wave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, state: { waves, posPreset: wavePosPresetName, brightPreset: waveBrightPresetName } }),
    }).then(fetchWavePresets).catch(console.error);
  };

  const loadWavePreset = (name: string) => {
    fetch(`/api/presets/wave/${encodeURIComponent(name)}`)
      .then((r) => r.json() as Promise<unknown>)
      .then((data) => {
        if (Array.isArray(data)) {
          setWaves(data as Wave[]);
        } else {
          const d = data as { waves: Wave[]; posPreset?: string | null; brightPreset?: string | null };
          setWaves(d.waves);
          setWavePosPresetName(d.posPreset ?? null);
          setWaveBrightPresetName(d.brightPreset ?? null);
        }
      })
      .catch(console.error);
  };

  const deleteWavePreset = (name: string) => {
    void fetch(`/api/presets/wave/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(fetchWavePresets)
      .catch(console.error);
  };

  const startWave = () => {
    const posSource = wavePosSnapshotRef.current;
    const brightSource = waveBrightSnapshotRef.current;
    const basePos: Record<string, number> = {};
    const baseBright: Record<string, number> = {};
    BULBS.forEach((b) => {
      const cur = bulbStateRef.current[b.id] ?? { pos: 0.5, bright: 0 };
      basePos[b.id] = posSource ? (posSource[b.id]?.pos ?? cur.pos) : cur.pos;
      baseBright[b.id] = brightSource ? (brightSource[b.id]?.bright ?? cur.bright) : cur.bright;
    });
    const resolvedWaves = waves.map((w) => {
      const grp = w.groupId ? groups.find((g) => g.id === w.groupId) : null;
      const targetIds = grp
        ? grp.ids
        : selection.size > 0 ? [...selection] : BULBS.map((b) => b.id);
      return { ...w, targetIds };
    });
    fetch('/api/wave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        waves: resolvedWaves,
        basePos,
        baseBright,
        posPreset: wavePosPresetName,
        brightPreset: waveBrightPresetName,
        elapsed: waveElapsedRef.current,
      }),
    })
      .then((r) => r.json() as Promise<{ startedAt: number }>)
      .then(({ startedAt }) => {
        waveServerStartRef.current = startedAt;
        setIsPlaying(true);
      })
      .catch(console.error);
  };

  const stopWave = () => {
    void fetch('/api/wave', { method: 'DELETE' }).catch(console.error);
    setIsPlaying(false);
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
    pushBulbs(bulbStateRef.current);
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
  const deleteGroup = (id: string) => {
    setGroups((gs) => gs.filter((g) => g.id !== id));
    if (activeGroup === id) setActiveGroup(null);
  };

  // Wave animation
  // waveServerStartRef: Unix epoch seconds at which t=0 of the current wave run corresponds to.
  const waveServerStartRef = useRef(0);
  const waveElapsedRef = useRef(0);
  useEffect(() => {
    if (!isPlaying) return;
    const posSource = wavePosSnapshotRef.current;
    const brightSource = waveBrightSnapshotRef.current;
    const baseSnapshot: BulbState = {};
    BULBS.forEach((b) => {
      const cur = bulbStateRef.current[b.id] ?? { pos: 0.5, bright: 0 };
      baseSnapshot[b.id] = {
        pos: posSource ? (posSource[b.id]?.pos ?? cur.pos) : cur.pos,
        bright: brightSource ? (brightSource[b.id]?.bright ?? cur.bright) : cur.bright,
      };
    });
    let raf = 0;

    const tick = () => {
      // Sync with the server's clock so the visual display matches the hardware.
      const t = Date.now() / 1000 - waveServerStartRef.current;

      // Accumulate additive offsets from each wave
      const posOff: Record<string, number> = {};
      const brightOff: Record<string, number> = {};

      waves.forEach((w) => {
        const waveGroup = w.groupId ? groups.find((g) => g.id === w.groupId) : null;
        const targets = waveGroup
          ? waveGroup.ids
          : selection.size > 0 ? [...selection] : BULBS.map((b) => b.id);

        if (w.pattern === 'spin') {
          const spinRings = new Map<number, string[]>();
          BULBS.forEach((b) => {
            if (b.ring === 0 || !targets.includes(b.id)) return;
            const list = spinRings.get(b.ring) ?? [];
            list.push(b.id);
            spinRings.set(b.ring, list);
          });
          const rotOffset = (w.spinReverse ? -1 : 1) * ((t / w.spinPeriod) % 1);
          spinRings.forEach((ring) => {
            const n = ring.length;
            const shift = rotOffset * n;
            ring.forEach((id, i) => {
              const src = ((i + shift) % n + n) % n;
              const lo = Math.floor(src) % n;
              const hi = (lo + 1) % n;
              const frac = src - Math.floor(src);
              const blo = baseSnapshot[ring[lo]] ?? { pos: 0.5, bright: 0 };
              const bhi = baseSnapshot[ring[hi]] ?? { pos: 0.5, bright: 0 };
              const base_i = baseSnapshot[id] ?? { pos: 0.5, bright: 0 };
              if (w.target === 'brightness') {
                brightOff[id] = (brightOff[id] ?? 0) + (blo.bright + frac * (bhi.bright - blo.bright) - base_i.bright);
              } else {
                posOff[id] = (posOff[id] ?? 0) + (blo.pos + frac * (bhi.pos - blo.pos) - base_i.pos);
              }
            });
          });
        } else {
          targets.forEach((id) => {
            const b = BULBS.find((x) => x.id === id);
            if (!b) return;
            const dir = (w.direction * Math.PI) / 180;
            const k = (2 * Math.PI) / w.wavelength / 5;
            const phaseOffset =
              w.pattern === 'ripple'
                ? Math.sqrt(b.x3 * b.x3 + b.z3 * b.z3) * k
                : (b.x3 * Math.cos(dir) + b.z3 * Math.sin(dir)) * k;
            const omega = 2 * Math.PI * w.speed * 0.04;
            const v = Math.sin(omega * t - phaseOffset);
            const o = v * w.amp * 0.4;
            if (w.target === 'brightness') {
              brightOff[id] = (brightOff[id] ?? 0) + o;
            } else {
              posOff[id] = (posOff[id] ?? 0) + o;
            }
          });
        }
      });

      // Apply accumulated offsets to base snapshot
      const next = { ...bulbStateRef.current };
      BULBS.forEach((b) => {
        const base = baseSnapshot[b.id] ?? { pos: 0.5, bright: 0 };
        next[b.id] = {
          pos: Math.max(0, Math.min(1, base.pos + (posOff[b.id] ?? 0))),
          bright: Math.max(0, Math.min(1, base.bright + (brightOff[b.id] ?? 0))),
        };
      });

      setBulbState(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Save elapsed so the next resume continues from the same point.
      waveElapsedRef.current = Date.now() / 1000 - waveServerStartRef.current;
    };
  }, [isPlaying, waves]); // eslint-disable-line react-hooks/exhaustive-deps

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
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
    const payload: BulbState = {};
    selection.forEach((id) => {
      const cur = bulbStateRef.current[id];
      if (cur) payload[id] = { ...cur, bright: b };
    });
    pushBulbs(payload);
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
          <button
            className="iconbtn stop-btn"
            title="Stop all (disable)"
            onClick={() => {
              setDisabledAll(true);
              prevDisabledAllRef.current = true;
              void fetch('/api/disable', { method: 'POST' }).catch(console.error);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="3" width="10" height="10" rx="1.5" />
            </svg>
          </button>
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

      {/* Dimmer strip */}
      <aside className="dimmer-strip">
        <input
          type="range"
          min="0"
          max="1"
          step={1 / 256}
          value={dimmer}
          onChange={(e) => {
            const d = parseFloat(e.target.value);
            dimmerRef.current = d;
            setDimmer(d);
            dimmerAbortRef.current?.abort();
            dimmerAbortRef.current = new AbortController();
            if (isPlaying) {
              void fetch('/api/dimmer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dimmer: d }),
                signal: dimmerAbortRef.current.signal,
              }).catch((err: Error) => {
                if (err.name !== 'AbortError') console.error('Failed to push dimmer:', err);
              });
            } else {
              void fetch('/api/bulbs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dimState(bulbStateRef.current)),
                signal: dimmerAbortRef.current.signal,
              }).catch((err: Error) => {
                if (err.name !== 'AbortError') console.error('Failed to push dimmer state:', err);
              });
            }
          }}
          onPointerUp={(e) => {
            const d = parseFloat((e.target as HTMLInputElement).value);
            void fetch('/api/settings/dimmer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dimmer: d }),
            }).catch(console.error);
          }}
        />
        <span className="dimmer-label">Dim</span>
      </aside>

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
          <CollapsibleSection title="Settings">
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
            <div className="settings-row">
              <label className="settings-label">
                Brightness on startup
                <span className="settings-value">{Math.round(startupBrightness * 100)}%</span>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={startupBrightness}
                onChange={(e) => setStartupBrightness(parseFloat(e.target.value))}
                onPointerUp={(e) => {
                  const brightness = parseFloat((e.target as HTMLInputElement).value);
                  void fetch('/api/settings/startup-brightness', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ brightness }),
                  }).catch(console.error);
                }}
                className="settings-slider"
              />
              <div className="settings-range-labels">
                <span>0%</span>
                <span>100%</span>
              </div>
            </div>
            <div className="settings-row">
              <label className="settings-label">
                Position gain (Kp)
                <span className="settings-value">{kpPos.toFixed(1)}</span>
              </label>
              <input
                type="range"
                min={0.5}
                max={6}
                step={0.1}
                value={kpPos}
                onChange={(e) => setKpPos(parseFloat(e.target.value))}
                onPointerUp={(e) => {
                  const kp_pos = parseFloat((e.target as HTMLInputElement).value);
                  void fetch('/api/settings/kp-pos', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kp_pos }),
                  }).catch(console.error);
                }}
                className="settings-slider"
              />
              <div className="settings-range-labels">
                <span>0.5</span>
                <span>10</span>
              </div>
            </div>
            <div className="settings-row">
              <label className="settings-label">
                Max speed
                <span className="settings-value">{maxIps.toFixed(1)} in/s</span>
              </label>
              <input
                type="range"
                min={0.1}
                max={2.4}
                step={0.1}
                value={maxIps}
                onChange={(e) => setMaxIps(parseFloat(e.target.value))}
                onPointerUp={(e) => {
                  const max_ips = parseFloat((e.target as HTMLInputElement).value);
                  void fetch('/api/settings/max-ips', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ max_ips }),
                  }).catch(console.error);
                }}
                className="settings-slider"
              />
              <div className="settings-range-labels">
                <span>0.1 in/s</span>
                <span>2.4 in/s</span>
              </div>
            </div>
          </CollapsibleSection>
        )}

        {mode !== 'settings' && (
          <>
            <CollapsibleSection title="Selection">
              <Inspector
                selectedIds={selection}
                bulbState={bulbState}
                bulbStatus={bulbStatus}
                maxLength={maxLength}
                onClear={handleClear}
                onToggleLight={(ids) => {
                  void fetch('/api/toggle-light', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(ids),
                  }).catch((err) => console.error('Failed to toggle light:', err));
                }}
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
                  <button className="btn" onClick={() => setBrightForSelection(0)}>Off</button>
                  <button className="btn" onClick={() => setBrightForSelection(0.05)}>5%</button>
                  <button className="btn" onClick={() => setBrightForSelection(0.15)}>15%</button>
                  <button className="btn" onClick={() => setBrightForSelection(0.25)}>25%</button>
                  <button className="btn" onClick={() => setBrightForSelection(0.5)}>50%</button>
                  <button className="btn" onClick={() => setBrightForSelection(1)}>Full</button>
                </div>
              )}
            </CollapsibleSection>

            {mode !== 'wave' && (
              <CollapsibleSection title="Groups">
                <GroupsPanel
                  groups={groups}
                  activeGroup={activeGroup}
                  onActivate={activateGroup}
                  onCreate={createGroup}
                  onDelete={deleteGroup}
                  currentSelectionCount={selection.size}
                />
              </CollapsibleSection>
            )}

            {mode === 'presets' && (
              <CollapsibleSection title="Position Presets">
                <PresetsPanel
                  kind="position"
                  presets={positionPresets}
                  previewing={previewingPreset}
                  onPreview={previewPositionPreset}
                  onCancelPreview={cancelPreview}
                  onLoad={loadPreset}
                  onSave={savePositionPreset}
                  onDelete={deletePositionPreset}
                />
              </CollapsibleSection>
            )}

            {mode === 'presets' && (
              <CollapsibleSection title="Brightness Presets">
                <PresetsPanel
                  kind="brightness"
                  presets={brightnessPresets}
                  previewing={previewingPreset}
                  onPreview={previewBrightnessPreset}
                  onCancelPreview={cancelPreview}
                  onLoad={loadPreset}
                  onSave={saveBrightnessPreset}
                  onDelete={deleteBrightnessPreset}
                />
              </CollapsibleSection>
            )}

            {mode === 'wave' && (
              <section className="rail-section">
                <WavePanel
                  waves={waves}
                  onWaves={setWaves}
                  positionPresets={positionPresets}
                  brightnessPresets={brightnessPresets}
                  wavePosPresetName={wavePosPresetName}
                  onWavePosPresetName={setWavePosPresetName}
                  waveBrightPresetName={waveBrightPresetName}
                  onWaveBrightPresetName={setWaveBrightPresetName}
                  groups={groups}
                  wavePresets={wavePresets}
                  onLoadWavePreset={loadWavePreset}
                  onSaveWavePreset={saveWavePreset}
                  onDeleteWavePreset={deleteWavePreset}
                  isPlaying={isPlaying}
                  onPlay={startWave}
                  onStop={stopWave}
                />
              </section>
            )}
          </>
        )}
      </aside>

      {disabledAll && (
        <div className="disable-overlay" onClick={handleRestoreFromDisable} />
      )}
    </div>
  );
}

export default App;
