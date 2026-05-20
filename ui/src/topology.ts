// Canonical bulb topology — mirror of src/topology.rs in the Rust crate.
// IDs and angles match exactly; if you change one, change the other.
//
// Address layout (offsets from i2c.base_address):
//   - 0          : center
//   - 1 ..= 6    : inner ring (i=0 at 0°, going CCW)
//   - 7 ..= 18   : outer ring (i=0 at 0°, going CCW)

import type { Bulb } from './types';

const TAU = Math.PI * 2;

const INNER_COUNT = 6;
const INNER_RADIUS = 1.0;
const INNER_ANGLE_OFFSET = 0;

const OUTER_COUNT = 12;
const OUTER_RADIUS = 1.932;
const OUTER_ANGLE_OFFSET = 0;

export const TOTAL_BULBS = 1 + INNER_COUNT + OUTER_COUNT;

function buildBulbLayout(): Bulb[] {
  const bulbs: Bulb[] = [{ id: 'c', ring: 0, ringIndex: 0, x3: 0, z3: 0 }];
  for (let i = 0; i < INNER_COUNT; i++) {
    const a = -(i / INNER_COUNT) * TAU + INNER_ANGLE_OFFSET;
    bulbs.push({
      id: `r1-${i}`,
      ring: 1,
      ringIndex: i,
      x3: Math.cos(a) * INNER_RADIUS,
      z3: Math.sin(a) * INNER_RADIUS,
    });
  }
  for (let i = 0; i < OUTER_COUNT; i++) {
    const a = -(i / OUTER_COUNT) * TAU + OUTER_ANGLE_OFFSET;
    bulbs.push({
      id: `r2-${i}`,
      ring: 2,
      ringIndex: i,
      x3: Math.cos(a) * OUTER_RADIUS,
      z3: Math.sin(a) * OUTER_RADIUS,
    });
  }
  return bulbs;
}

export const BULBS = buildBulbLayout();
