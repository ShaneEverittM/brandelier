// Deterministic noise for the "random" wave pattern. Ported bit-for-bit from
// src/wave.rs so the frontend's live preview matches what the server drives
// the hardware with (same seed + bulb id + t always produce the same value).

// Bit-mixing hash (lowbias32): turns an arbitrary u32 into a well-distributed
// pseudo-random u32. Math.imul gives the same wrapping 32-bit multiply as
// Rust's `u32::wrapping_mul`.
function hashU32(x: number): number {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Probability that any given integer grid boundary is a "live" breakpoint
// (see noiseValue). Segments span at least 1 grid cell by construction and
// average 1/RENEWAL_P_ACTIVE cells (geometric distribution) — here, ~2.86.
const RENEWAL_P_ACTIVE = 0.35;

// Cap on how many grid cells noiseValue will walk while searching for a
// live breakpoint. Purely a defensive backstop: the probability of needing
// more than a few steps is already tiny (each step independently has a 35%
// chance of ending the search), and needing all 64 is astronomically
// unlikely — (1 - RENEWAL_P_ACTIVE)^64 ≈ 10^-12.
const RENEWAL_MAX_WALK = 64;

const RENEWAL_ACTIVE_SALT = 0x2545f491;
const RENEWAL_VALUE_SALT = 0x27d4eb2f;
const RENEWAL_TANGENT_SALT = 0x165667b1;

// Hash the grid boundary `i` of a given bulb's noise line into a fresh u32,
// salted so isLive, boundaryValue, and boundaryTangent draw independent
// randomness from the same boundary index.
function hashBoundary(bulbSeed: number, i: number, salt: number): number {
  const idx = Math.imul(i | 0, 0x9e3779b1) >>> 0;
  return hashU32(((bulbSeed + idx) ^ salt) >>> 0);
}

// Whether grid boundary `i` is a live breakpoint (see noiseValue).
function isLive(bulbSeed: number, i: number): boolean {
  const h = hashBoundary(bulbSeed, i, RENEWAL_ACTIVE_SALT);
  return h / 4294967296 < RENEWAL_P_ACTIVE;
}

// Pseudo-random value in [-1, 1] at a live breakpoint.
function boundaryValue(bulbSeed: number, i: number): number {
  const h = hashBoundary(bulbSeed, i, RENEWAL_VALUE_SALT);
  return (h / 4294967295) * 2 - 1;
}

// Pseudo-random Hermite tangent in [-1, 1] at a live breakpoint. Drawn
// independently of boundaryValue (not derived from neighbors), but shared
// between the segment ending at `i` and the one starting at `i` — both look
// it up from the same (bulbSeed, i), so the spline's value and its shape
// are continuous across the breakpoint even though its physical speed can
// change (segments differ in length either side).
function boundaryTangent(bulbSeed: number, i: number): number {
  const h = hashBoundary(bulbSeed, i, RENEWAL_TANGENT_SALT);
  return (h / 4294967295) * 2 - 1;
}

function findLiveBackward(bulbSeed: number, start: number): number {
  let i = start;
  for (let step = 0; step < RENEWAL_MAX_WALK; step++) {
    if (isLive(bulbSeed, i)) return i;
    i -= 1;
  }
  return i;
}

function findLiveForward(bulbSeed: number, start: number): number {
  let i = start;
  for (let step = 0; step < RENEWAL_MAX_WALK; step++) {
    if (isLive(bulbSeed, i)) return i;
    i += 1;
  }
  return i;
}

// Deterministic noise in [-1, 1] for bulb `id` at time `t`, built from a
// renewal process rather than a fixed lattice. Grid boundaries (spaced
// minPeriod apart) are each independently "live" or not with probability
// RENEWAL_P_ACTIVE; a segment runs between two consecutive live boundaries.
// Unlike a fixed-lattice noise (Perlin included), where every bulb changes
// character on the same metronomic beat and every transition is shaped by
// the same fixed formula, this makes the *timing* itself irregular and
// unpredictable per bulb — segments are always at least minPeriod (never
// faster than the floor) but their actual length is random, typically
// several multiples of it. Each live boundary also gets its own
// independently random Hermite tangent (not derived from neighbors), so
// motion still flows continuously through every breakpoint — it only
// pauses on the rare coincidence of a near-zero tangent — while avoiding a
// repeated compositional "shape" across bulbs or over time.
//
// Bound: a cubic Hermite spline H(t) = h00·v0 + h10·m0 + h01·v1 + h11·m1
// (t in [0,1]) is linear in v0, v1, m0, m1, so its extremum over [-1,1]^4
// occurs at a sign combination of those four; sweeping t numerically
// against |h00|+|h10|+|h01|+|h11| gives an exact max of 1.25, at t=0.5.
// Scaling by 0.8 (=1/1.25) therefore normalizes the *true* worst case to
// [-1, 1] — not an empirical fudge factor. The clamp is just a defensive
// backstop against float error.
export function noiseValue(seed: number, id: string, minPeriod: number, t: number): number {
  const mp = Math.max(minPeriod, 0.05);
  const bulbSeed = (seed ^ fnv1a(id)) >>> 0;
  const x = t / mp;
  const cell = Math.floor(x);
  const p1 = findLiveBackward(bulbSeed, cell);
  const p2 = findLiveForward(bulbSeed, cell + 1);
  const v0 = boundaryValue(bulbSeed, p1);
  const v1 = boundaryValue(bulbSeed, p2);
  const m0 = boundaryTangent(bulbSeed, p1);
  const m1 = boundaryTangent(bulbSeed, p2);
  const lt = (x - p1) / (p2 - p1);
  const lt2 = lt * lt;
  const lt3 = lt2 * lt;
  const h00 = 2 * lt3 - 3 * lt2 + 1;
  const h10 = lt3 - 2 * lt2 + lt;
  const h01 = -2 * lt3 + 3 * lt2;
  const h11 = lt3 - lt2;
  const raw = h00 * v0 + h10 * m0 + h01 * v1 + h11 * m1;
  return Math.max(-1, Math.min(1, raw * 0.8));
}
