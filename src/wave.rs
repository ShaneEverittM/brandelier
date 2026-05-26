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

    loop {
        tokio::select! {
            biased;
            _ = token.cancelled() => break,
            _ = ticker.tick() => {}
        }

        let t = start.elapsed().as_secs_f64() + req.elapsed;

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
                    for b in &targets {
                        let phase = if w.pattern == WavePattern::Ripple {
                            (b.x * b.x + b.z * b.z).sqrt() * k
                        } else {
                            (b.x * dir.cos() + b.z * dir.sin()) * k
                        };
                        let o = (omega * t - phase).sin() * w.amp * 0.4;
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
            warn!("wave tick: driver error: {e}");
            break;
        }
    }
}
