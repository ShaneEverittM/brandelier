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
  light_on: boolean;
  zeroing: boolean;
  disabled: boolean;
  eeprom_error: boolean;
  drift_detected: boolean;
};
export type BulbStatusMap = Record<BulbId, BulbStatusEntry>;

export type Camera = { yaw: number; elevation: number };

export type PresetKind = 'position' | 'brightness';

export type WavePattern = 'sine' | 'ripple' | 'spin';
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
};

export type Group = {
  id: string;
  name: string;
  ids: BulbId[];
  builtin?: boolean;
};

export type RenderStyle = 'flat' | 'glow' | 'wire';

export type Mode = 'presets' | 'wave' | 'schedule' | 'settings';

export type DragAxis = 'x' | 'y' | null;
export type DragDelta = { dx: number; dy: number; axis: DragAxis; ctrl: boolean };
