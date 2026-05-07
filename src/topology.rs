//! Canonical bulb topology for the chandelier.
//!
//! 19 bulbs arranged as 1 center + an inner ring of 6 (radius 1) + an outer
//! ring of 12 (radius 2). The (x, z) coordinates here are in the chandelier's
//! horizontal plane (looking down from above); the cord drop is the
//! per-bulb extension and is not part of topology.
//!
//! IDs and angles are identical to the frontend's `src/topology.ts`; if you
//! change one, change the other.
//!
//! i2c addresses are not derived here — they're supplied per-position by
//! `[topology]` in the config file.

use std::f64::consts::TAU;

use ordered_float::OrderedFloat;

use crate::config;
use crate::i2c::Position;

pub type BulbId = String;

/// Sentinel address meaning "no hardware wired here yet". Chosen because it's
/// outside the legal 7-bit i2c slave range (0x08..=0x77) so it can never
/// collide with a real device.
pub const DISABLED_ADDRESS: u16 = 0xFF;

/// Inclusive bounds of the legal 7-bit i2c slave address range. Below 0x08 is
/// reserved by the i2c spec (general call, CBUS, Hs-mode masters); above 0x77
/// is reserved (10-bit prefix, etc.).
pub const MIN_VALID_ADDRESS: u16 = 0x08;
pub const MAX_VALID_ADDRESS: u16 = 0x77;

#[derive(serde::Serialize)]
pub struct BulbSlot {
    pub id: BulbId,
    pub position: Position,
    pub address: u16,
    pub disabled: bool,
}

pub const INNER_COUNT: u16 = 6;
const INNER_RADIUS: f64 = 5.715;
const INNER_ANGLE_OFFSET: f64 = 0.0;

pub const OUTER_COUNT: u16 = 12;
const OUTER_RADIUS: f64 = 11.041;
const OUTER_ANGLE_OFFSET: f64 = 0.0;

#[allow(dead_code)]
pub const TOTAL_BULBS: u16 = 1 + INNER_COUNT + OUTER_COUNT;

/// Build the canonical 19 bulb slots in order: center, inner ring (CCW from
/// 0°), outer ring (CCW from 0°). i2c addresses come from `topology`; a slot
/// whose address is [`DISABLED_ADDRESS`] is marked `disabled`.
///
/// Caller is responsible for having validated `topology` (see
/// [`config::Topology::validate`]) — this will panic on length mismatch.
pub fn bulbs(topology: &config::Topology) -> Vec<BulbSlot> {
    let mut slots = Vec::with_capacity(TOTAL_BULBS as usize);

    slots.push(BulbSlot {
        id: "c".into(),
        position: Position {
            x: OrderedFloat(0.0),
            y: OrderedFloat(0.0),
        },
        address: topology.center,
        disabled: topology.center == DISABLED_ADDRESS,
    });

    for i in 0..INNER_COUNT {
        let a = (i as f64 / INNER_COUNT as f64) * TAU + INNER_ANGLE_OFFSET;
        let address = topology.inner[i as usize];
        slots.push(BulbSlot {
            id: format!("r1-{i}"),
            position: Position {
                x: OrderedFloat(a.cos() * INNER_RADIUS),
                y: OrderedFloat(a.sin() * INNER_RADIUS),
            },
            address,
            disabled: address == DISABLED_ADDRESS,
        });
    }

    for i in 0..OUTER_COUNT {
        let a = (i as f64 / OUTER_COUNT as f64) * TAU + OUTER_ANGLE_OFFSET;
        let address = topology.outer[i as usize];
        slots.push(BulbSlot {
            id: format!("r2-{i}"),
            position: Position {
                x: OrderedFloat(a.cos() * OUTER_RADIUS),
                y: OrderedFloat(a.sin() * OUTER_RADIUS),
            },
            address,
            disabled: address == DISABLED_ADDRESS,
        });
    }

    slots
}
