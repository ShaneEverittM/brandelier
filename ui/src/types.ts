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

export type Mode = 'manual' | 'wave' | 'precise';

export type DragAxis = 'x' | 'y' | null;
export type DragDelta = { dx: number; dy: number; axis: DragAxis };
