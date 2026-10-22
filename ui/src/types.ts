export type BulbId = string;

export type Bulb = {
  id: BulbId;
  ring: 0 | 1 | 2;
  ringIndex: number;
  x3: number;
  z3: number;
};

export type BulbStateEntry = { pos: number; bright: number };
export type BulbState = Record<BulbId, BulbStateEntry>;

export type BulbStatusEntry = {
  pos: number;
  bright: number;
  light_on: boolean;
  zeroing: boolean;
  disabled: boolean;
  max_speed_warn: boolean;
  drift_detected: boolean;
  read_error: boolean;
};
export type BulbStatusMap = Record<BulbId, BulbStatusEntry>;

export type Camera = { yaw: number; elevation: number };

export type PresetKind = 'position' | 'brightness';

export type WavePattern = 'sine' | 'ripple' | 'spin' | 'random' | 'sweep';
export type WaveTarget = 'extension' | 'brightness';

export type Wave = {
  pattern: WavePattern;
  target: WaveTarget;
  amp: number;
  speed: number;
  wavelength: number;
  direction: number;
  spinPeriod: number;
  spinReverse: boolean;
  center: BulbId | null;
  decay: number;
  /// Minimum seconds between random breakpoints. Only used by 'random'.
  minPeriod: number;
  /// Fixed per wave instance so playback is reproducible. Only used by 'random'.
  seed: number;
  /// Sector angular width in degrees (0-360). Only used by 'sweep'.
  spreadDeg: number;
  /// Whether the sweep bump adds (true) or subtracts (false). Only used by 'sweep'.
  bumpUp: boolean;
  /// Starting angular offset in degrees, added on top of the rotation.
  /// Lets multiple sweeps share a period but stay staggered. Only used by 'sweep'.
  phaseDeg: number;
  groupId: string | null;
};

export type Group = {
  id: string;
  name: string;
  ids: BulbId[];
  builtin?: boolean;
};

export type RenderStyle = 'flat' | 'glow' | 'wire';

export type ScheduleKind = 'position' | 'wave';

export type ScheduleEntry = {
  id: string;
  /// 0 = Sunday .. 6 = Saturday, matching JS Date.getDay().
  day: number;
  /// Minutes since midnight (0-1439).
  startMin: number;
  /// Minutes; an entry never crosses midnight (startMin + durationMin <= 1440).
  durationMin: number;
  kind: ScheduleKind;
  /// Name of the position or wave preset (matching `kind`) this block plays.
  preset: string;
};

export type ScheduleDoc = {
  enabled: boolean;
  entries: ScheduleEntry[];
};

export type Mode = 'presets' | 'wave' | 'schedule' | 'settings';

export type DragAxis = 'x' | 'y' | null;
export type DragDelta = { dx: number; dy: number; axis: DragAxis; ctrl: boolean };
