use std::collections::HashMap;
use std::f64::consts::TAU;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kameo::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::time::{Instant, MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::driver::{BulbCommand, Driver, SetAll};
use crate::topology::BulbId;

const TICK_HZ: f64 = 30.0;

const INNER_COUNT: usize = 6;
const OUTER_COUNT: usize = 12;
const INNER_RADIUS: f64 = 1.0;
const OUTER_RADIUS: f64 = 1.932;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WavePattern {
    Sine,
    Ripple,
    Spin,
    Random,
    Sweep,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WaveTarget {
    Extension,
    Brightness,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveConfig {
    pub pattern: WavePattern,
    pub target: WaveTarget,
    pub amp: f64,
    pub speed: f64,
    pub wavelength: f64,
    pub direction: f64,
    pub spin_period: f64,
    pub spin_reverse: bool,
    /// Bulb the ripple radiates from. `None` defaults to the center bulb.
    /// Ignored by other patterns.
    #[serde(default)]
    pub center: Option<BulbId>,
    /// Ripple amplitude falloff per unit distance from `center` (0 = no
    /// falloff). Ignored by other patterns.
    #[serde(default)]
    pub decay: f64,
    /// Minimum seconds between random breakpoints for the `Random` pattern.
    /// Ignored by other patterns.
    #[serde(default = "default_min_period")]
    pub min_period: f64,
    /// Random seed for the `Random` pattern's noise stream, fixed per wave
    /// instance so playback is reproducible across pause/resume and between
    /// the server and the frontend's own preview. Ignored by other patterns.
    #[serde(default)]
    pub seed: u32,
    /// Sector angular width in degrees (0–360) for the `Sweep` pattern's
    /// rotating bump. Ignored by other patterns.
    #[serde(default = "default_spread_deg")]
    pub spread_deg: f64,
    /// Whether the `Sweep` pattern's bump adds to the target (true) or
    /// subtracts from it (false). Ignored by other patterns.
    #[serde(default = "true_bool")]
    pub bump_up: bool,
    /// Starting angular offset in degrees for the `Sweep` pattern's rotating
    /// bump, added on top of the rotation itself — lets multiple sweeps
    /// share the same rotation period but stay staggered around the circle.
    /// Ignored by other patterns.
    #[serde(default)]
    pub phase_deg: f64,
    /// Original group ID from the UI — stored for frontend restoration only.
    pub group_id: Option<String>,
    /// Resolved bulb IDs that this wave targets (frontend resolves groupId → ids).
    pub target_ids: Vec<BulbId>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWaveRequest {
    pub waves: Vec<WaveConfig>,
    /// Normalized [0,1] base position for each bulb (from preset or current state).
    pub base_pos: HashMap<BulbId, f64>,
    /// Normalized [0,1] base brightness for each bulb.
    pub base_bright: HashMap<BulbId, f64>,
    /// Position preset name selected in the UI, for frontend restoration.
    pub pos_preset: Option<String>,
    /// Brightness preset name selected in the UI, for frontend restoration.
    pub bright_preset: Option<String>,
    /// Seconds of elapsed wave time to resume from (preserves time across pause/resume).
    #[serde(default)]
    pub elapsed: f64,
    /// Global speed multiplier applied on top of individual wave speeds (0.01–1, default 1).
    #[serde(default = "one_f64")]
    pub overall_speed: f64,
}

fn one_f64() -> f64 { 1.0 }
fn default_min_period() -> f64 { 2.0 }
fn default_spread_deg() -> f64 { 60.0 }
fn true_bool() -> bool { true }

/// Bit-mixing hash (lowbias32) used to turn an arbitrary u32 into a
/// well-distributed pseudo-random u32. Ported line-for-line to the frontend
/// (ui/src/noise.ts) so both sides derive identical noise from the same seed.
fn hash_u32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

fn fnv1a(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Probability that any given integer grid boundary is a "live" breakpoint
/// (see `noise`). Segments span at least 1 grid cell by construction and
/// average `1/RENEWAL_P_ACTIVE` cells (geometric distribution) — here,
/// ~2.86 cells.
const RENEWAL_P_ACTIVE: f64 = 0.35;

/// Cap on how many grid cells `noise` will walk while searching for a live
/// breakpoint. Purely a defensive backstop: the probability of needing more
/// than a few steps is already tiny (each step independently has a 35%
/// chance of ending the search), and needing all 64 is astronomically
/// unlikely — `(1 - RENEWAL_P_ACTIVE)^64 ≈ 10^-12`.
const RENEWAL_MAX_WALK: i64 = 64;

const RENEWAL_ACTIVE_SALT: u32 = 0x2545_F491;
const RENEWAL_VALUE_SALT: u32 = 0x27D4_EB2F;
const RENEWAL_TANGENT_SALT: u32 = 0x1656_67B1;

/// Hash the grid boundary `i` of a given bulb's noise line into a fresh u32,
/// salted so `is_live`, `boundary_value`, and `boundary_tangent` draw
/// independent randomness from the same boundary index.
fn hash_boundary(bulb_seed: u32, i: i64, salt: u32) -> u32 {
    let idx = (i as i32 as u32).wrapping_mul(0x9E37_79B1);
    hash_u32(bulb_seed.wrapping_add(idx) ^ salt)
}

/// Whether grid boundary `i` is a live breakpoint (see `noise`).
fn is_live(bulb_seed: u32, i: i64) -> bool {
    let h = hash_boundary(bulb_seed, i, RENEWAL_ACTIVE_SALT);
    (h as f64 / (u32::MAX as f64 + 1.0)) < RENEWAL_P_ACTIVE
}

/// Pseudo-random value in [-1, 1] at a live breakpoint.
fn boundary_value(bulb_seed: u32, i: i64) -> f64 {
    let h = hash_boundary(bulb_seed, i, RENEWAL_VALUE_SALT);
    (h as f64 / u32::MAX as f64) * 2.0 - 1.0
}

/// Pseudo-random Hermite tangent in [-1, 1] at a live breakpoint. Drawn
/// independently of `boundary_value` (not derived from neighbors), but
/// shared between the segment ending at `i` and the one starting at `i` —
/// both look it up from the same `(bulb_seed, i)`, so the spline's value
/// and its shape are continuous across the breakpoint even though its
/// physical speed can change (segments differ in length either side).
fn boundary_tangent(bulb_seed: u32, i: i64) -> f64 {
    let h = hash_boundary(bulb_seed, i, RENEWAL_TANGENT_SALT);
    (h as f64 / u32::MAX as f64) * 2.0 - 1.0
}

fn find_live_backward(bulb_seed: u32, start: i64) -> i64 {
    let mut i = start;
    for _ in 0..RENEWAL_MAX_WALK {
        if is_live(bulb_seed, i) { return i; }
        i -= 1;
    }
    i
}

fn find_live_forward(bulb_seed: u32, start: i64) -> i64 {
    let mut i = start;
    for _ in 0..RENEWAL_MAX_WALK {
        if is_live(bulb_seed, i) { return i; }
        i += 1;
    }
    i
}

/// Deterministic noise in [-1, 1] for bulb `id` at time `t`, built from a
/// renewal process rather than a fixed lattice. Grid boundaries (spaced
/// `min_period` apart) are each independently "live" or not with
/// probability `RENEWAL_P_ACTIVE`; a segment runs between two consecutive
/// live boundaries. Unlike a fixed-lattice noise (Perlin included), where
/// every bulb changes character on the same metronomic beat and every
/// transition is shaped by the same fixed formula, this makes the *timing*
/// itself irregular and unpredictable per bulb — segments are always at
/// least `min_period` (never faster than the floor) but their actual length
/// is random, typically several multiples of it. Each live boundary also
/// gets its own independently random Hermite tangent (not derived from
/// neighbors), so motion still flows continuously through every breakpoint
/// — it only pauses on the rare coincidence of a near-zero tangent — while
/// avoiding a repeated compositional "shape" across bulbs or over time.
///
/// Bound: a cubic Hermite spline H(t) = h00·v0 + h10·m0 + h01·v1 + h11·m1
/// (t in [0,1]) is linear in v0, v1, m0, m1, so its extremum over
/// [-1,1]^4 occurs at a sign combination of those four; sweeping t
/// numerically against |h00|+|h10|+|h01|+|h11| gives an exact max of
/// 1.25, at t=0.5. Scaling by 0.8 (=1/1.25) therefore normalizes the
/// *true* worst case to [-1, 1] — not an empirical fudge factor. The clamp
/// is just a defensive backstop against float error.
fn noise(seed: u32, id: &str, min_period: f64, t: f64) -> f64 {
    let min_period = min_period.max(0.05);
    let bulb_seed = seed ^ fnv1a(id);
    let x = t / min_period;
    let cell = x.floor() as i64;
    let p1 = find_live_backward(bulb_seed, cell);
    let p2 = find_live_forward(bulb_seed, cell + 1);
    let v0 = boundary_value(bulb_seed, p1);
    let v1 = boundary_value(bulb_seed, p2);
    let m0 = boundary_tangent(bulb_seed, p1);
    let m1 = boundary_tangent(bulb_seed, p2);
    let lt = (x - p1 as f64) / (p2 - p1) as f64;
    let lt2 = lt * lt;
    let lt3 = lt2 * lt;
    let h00 = 2.0 * lt3 - 3.0 * lt2 + 1.0;
    let h10 = lt3 - 2.0 * lt2 + lt;
    let h01 = -2.0 * lt3 + 3.0 * lt2;
    let h11 = lt3 - lt2;
    let raw = h00 * v0 + h10 * m0 + h01 * v1 + h11 * m1;
    (raw * 0.8).clamp(-1.0, 1.0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveStarted {
    /// Unix epoch seconds at which t=0 of the wave corresponds to, for frontend sync.
    pub started_at: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveStatus {
    pub running: bool,
    pub started_at: Option<f64>,
    pub config: Option<StartWaveRequest>,
}

struct BulbMeta {
    id: BulbId,
    x: f64,
    z: f64,
    ring: u8,
}

fn all_bulbs() -> Vec<BulbMeta> {
    let mut v = Vec::with_capacity(1 + INNER_COUNT + OUTER_COUNT);
    v.push(BulbMeta { id: "c".into(), x: 0.0, z: 0.0, ring: 0 });
    for i in 0..INNER_COUNT {
        let a = -(i as f64 / INNER_COUNT as f64) * TAU;
        v.push(BulbMeta { id: format!("r1-{i}"), x: a.cos() * INNER_RADIUS, z: a.sin() * INNER_RADIUS, ring: 1 });
    }
    for i in 0..OUTER_COUNT {
        let a = -(i as f64 / OUTER_COUNT as f64) * TAU;
        v.push(BulbMeta { id: format!("r2-{i}"), x: a.cos() * OUTER_RADIUS, z: a.sin() * OUTER_RADIUS, ring: 2 });
    }
    v
}

pub async fn run(
    driver: ActorRef<Driver>,
    req: StartWaveRequest,
    token: CancellationToken,
    start: Instant,
    dimmer: Arc<Mutex<f64>>,
) {
    let bulbs = all_bulbs();

    let mut ticker = interval(Duration::from_secs_f64(1.0 / TICK_HZ));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut consecutive_errors: u32 = 0;

    loop {
        tokio::select! {
            biased;
            _ = token.cancelled() => break,
            _ = ticker.tick() => {}
        }

        let t = (start.elapsed().as_secs_f64() + req.elapsed) * req.overall_speed;

        let mut pos_off: HashMap<&str, f64> = HashMap::new();
        let mut bright_off: HashMap<&str, f64> = HashMap::new();

        for w in &req.waves {
            let targets: Vec<&BulbMeta> = bulbs.iter()
                .filter(|b| w.target_ids.contains(&b.id))
                .collect();

            match w.pattern {
                WavePattern::Spin => {
                    let mut rings: HashMap<u8, Vec<&BulbMeta>> = HashMap::new();
                    for b in &targets {
                        if b.ring == 0 { continue; }
                        rings.entry(b.ring).or_default().push(b);
                    }
                    let rot = (if w.spin_reverse { -1.0 } else { 1.0 }) * ((t / w.spin_period) % 1.0);
                    for ring in rings.values() {
                        let n = ring.len();
                        let shift = rot * n as f64;
                        for (i, b) in ring.iter().enumerate() {
                            let src = ((i as f64 + shift) % n as f64 + n as f64) % n as f64;
                            let lo = src.floor() as usize % n;
                            let hi = (lo + 1) % n;
                            let frac = src - src.floor();
                            let blo = ring[lo].id.as_str();
                            let bhi = ring[hi].id.as_str();
                            let bi = b.id.as_str();
                            match w.target {
                                WaveTarget::Brightness => {
                                    let v_lo = req.base_bright.get(blo).copied().unwrap_or(0.0);
                                    let v_hi = req.base_bright.get(bhi).copied().unwrap_or(0.0);
                                    let v_i  = req.base_bright.get(bi).copied().unwrap_or(0.0);
                                    *bright_off.entry(bi).or_default() += v_lo + frac * (v_hi - v_lo) - v_i;
                                }
                                WaveTarget::Extension => {
                                    let v_lo = req.base_pos.get(blo).copied().unwrap_or(0.5);
                                    let v_hi = req.base_pos.get(bhi).copied().unwrap_or(0.5);
                                    let v_i  = req.base_pos.get(bi).copied().unwrap_or(0.5);
                                    *pos_off.entry(bi).or_default() += v_lo + frac * (v_hi - v_lo) - v_i;
                                }
                            }
                        }
                    }
                }
                WavePattern::Sine | WavePattern::Ripple => {
                    let dir = (w.direction * std::f64::consts::PI) / 180.0;
                    let k = TAU / w.wavelength / 5.0;
                    let omega = TAU * w.speed * 0.04;
                    let (cx, cz) = w.center.as_ref()
                        .and_then(|id| bulbs.iter().find(|b| &b.id == id))
                        .map(|b| (b.x, b.z))
                        .unwrap_or((0.0, 0.0));
                    for b in &targets {
                        let dist = ((b.x - cx).powi(2) + (b.z - cz).powi(2)).sqrt();
                        let phase = if w.pattern == WavePattern::Ripple {
                            dist * k
                        } else {
                            (b.x * dir.cos() + b.z * dir.sin()) * k
                        };
                        let decay_factor = if w.pattern == WavePattern::Ripple {
                            (-w.decay * dist).exp()
                        } else {
                            1.0
                        };
                        let o = (omega * t - phase).sin() * w.amp * decay_factor * 0.4;
                        match w.target {
                            WaveTarget::Brightness => { *bright_off.entry(b.id.as_str()).or_default() += o; }
                            WaveTarget::Extension  => { *pos_off.entry(b.id.as_str()).or_default() += o; }
                        }
                    }
                }
                WavePattern::Random => {
                    for b in &targets {
                        let o = noise(w.seed, &b.id, w.min_period, t) * w.amp * 0.4;
                        match w.target {
                            WaveTarget::Brightness => { *bright_off.entry(b.id.as_str()).or_default() += o; }
                            WaveTarget::Extension  => { *pos_off.entry(b.id.as_str()).or_default() += o; }
                        }
                    }
                }
                WavePattern::Sweep => {
                    let (cx, cz) = w.center.as_ref()
                        .and_then(|id| bulbs.iter().find(|b| &b.id == id))
                        .map(|b| (b.x, b.z))
                        .unwrap_or((0.0, 0.0));
                    let pivot_id = w.center.as_deref().unwrap_or("c");
                    let period = w.spin_period.max(0.01);
                    let rot_deg = (if w.spin_reverse { -1.0 } else { 1.0 }) * (t / period) * 360.0 + w.phase_deg;
                    let spread = w.spread_deg.clamp(0.0, 360.0).max(0.001);
                    let half = spread / 2.0;
                    // pos: 0 = high (short cord), 1 = low (long cord) — so a
                    // positive offset *lowers* a bulb. "Up" therefore needs a
                    // negative sign.
                    let sign = if w.bump_up { -1.0 } else { 1.0 };
                    for b in &targets {
                        // The pivot bulb has no defined angle around itself.
                        if b.id == pivot_id { continue; }
                        let angle_deg = (b.z - cz).atan2(b.x - cx).to_degrees();
                        let delta = ((angle_deg - rot_deg + 180.0).rem_euclid(360.0)) - 180.0;
                        if delta.abs() > half { continue; }
                        // A full cosine cycle across the sector, rescaled to
                        // [0, 1]: 0 at both edges *with zero slope there*
                        // (like a real sine trough), peaking at 1 in the
                        // middle. Using half a sine cycle (0 to π) also
                        // starts/ends at 0, but its slope at those points is
                        // nonzero, so it visibly kinks where it meets the
                        // flat "outside sector" region; this doesn't. It
                        // only ever adds (or, with bump_up = false, only
                        // ever subtracts) — never crosses zero.
                        let frac = (delta + half) / spread;
                        let shape = (1.0 - (TAU * frac).cos()) / 2.0;
                        let o = shape * w.amp * sign * 0.4;
                        match w.target {
                            WaveTarget::Brightness => { *bright_off.entry(b.id.as_str()).or_default() += o; }
                            WaveTarget::Extension  => { *pos_off.entry(b.id.as_str()).or_default() += o; }
                        }
                    }
                }
            }
        }

        let commands: HashMap<BulbId, BulbCommand> = bulbs.iter().map(|b| {
            let base_p  = req.base_pos.get(b.id.as_str()).copied().unwrap_or(0.5);
            let base_br = req.base_bright.get(b.id.as_str()).copied().unwrap_or(0.0);
            let pos    = (base_p  + pos_off.get(b.id.as_str()).copied().unwrap_or(0.0)).clamp(0.0, 1.0);
            let d = *dimmer.lock().unwrap_or_else(|e| e.into_inner());
            let bright = ((base_br + bright_off.get(b.id.as_str()).copied().unwrap_or(0.0)) * d).clamp(0.0, 1.0);
            (b.id.clone(), BulbCommand { pos, bright })
        }).collect();

        if let Err(e) = driver.ask(SetAll { bulbs: commands }).await {
            consecutive_errors += 1;
            warn!("wave tick: driver error ({consecutive_errors}): {e}");
            if consecutive_errors >= 5 {
                warn!("wave: stopping after 5 consecutive errors");
                break;
            }
            continue;
        }
        consecutive_errors = 0;
    }
}
