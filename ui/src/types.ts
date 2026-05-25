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

export type WavePattern = 'sine' | 'ripple' | 'breath' | 'chase';
export type Wave = {
  pattern: WavePattern;
  amp: number;
  speed: number;
  phase: number;
};

export type Group = {
  id: string;
  name: string;
  ids: BulbId[];
};

export type RenderStyle = 'flat' | 'glow' | 'wire';

export type Mode = 'manual' | 'presets' | 'wave' | 'schedule';

export type DragAxis = 'x' | 'y' | null;
export type DragDelta = { dx: number; dy: number; axis: DragAxis; ctrl: boolean };
