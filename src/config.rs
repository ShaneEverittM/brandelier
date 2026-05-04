use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: Server,
    #[serde(default)]
    pub i2c: I2c,
    #[serde(default)]
    pub driver: Driver,
    #[serde(default)]
    pub topology: Topology,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Server {
    pub host: Ipv4Addr,
    pub port: u16,
    pub static_dir: String,
}

impl Default for Server {
    fn default() -> Self {
        Self {
            host: Ipv4Addr::UNSPECIFIED,
            port: 5001,
            static_dir: "static".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct I2c {
    pub device_path: String,
    pub retries: usize,
    pub retry_delay_ms: u64,
    pub rate_limit_ms: u64,
}

impl I2c {
    pub fn retry_delay(&self) -> Duration {
        Duration::from_millis(self.retry_delay_ms)
    }

    pub fn rate_limit(&self) -> Duration {
        Duration::from_millis(self.rate_limit_ms)
    }
}

impl Default for I2c {
    fn default() -> Self {
        Self {
            device_path: "/dev/i2c-1".into(),
            retries: 3,
            retry_delay_ms: 20,
            rate_limit_ms: 40,
        }
    }
}

/// Maps logical bulb positions to i2c addresses.
///
/// `inner` must have exactly [`crate::topology::INNER_COUNT`] entries (one per
/// inner-ring bulb, indexed by `ringIndex`); `outer` must have exactly
/// [`crate::topology::OUTER_COUNT`] entries.
///
/// Each address must be either a legal 7-bit i2c slave address
/// (0x08..=0x77) or the sentinel [`crate::topology::DISABLED_ADDRESS`]
/// (0xFF), which marks the position as not yet wired up — the driver skips
/// disabled positions entirely.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Topology {
    pub center: u16,
    pub inner: Vec<u16>,
    pub outer: Vec<u16>,
}

impl Topology {
    pub fn validate(&self) -> Result<(), String> {
        use crate::topology::{
            DISABLED_ADDRESS, INNER_COUNT, MAX_VALID_ADDRESS, MIN_VALID_ADDRESS, OUTER_COUNT,
        };

        let inner_expected = INNER_COUNT as usize;
        let outer_expected = OUTER_COUNT as usize;
        if self.inner.len() != inner_expected {
            return Err(format!(
                "topology.inner must have {inner_expected} addresses, got {}",
                self.inner.len()
            ));
        }
        if self.outer.len() != outer_expected {
            return Err(format!(
                "topology.outer must have {outer_expected} addresses, got {}",
                self.outer.len()
            ));
        }

        // Walk every position, validating each address against the legal i2c
        // slave range or the disabled sentinel, and ensuring no two enabled
        // positions collide on the same address.
        let mut seen: HashMap<u16, String> = HashMap::new();
        let positions = std::iter::once(("center".to_owned(), self.center))
            .chain(
                self.inner
                    .iter()
                    .enumerate()
                    .map(|(i, &a)| (format!("inner[{i}]"), a)),
            )
            .chain(
                self.outer
                    .iter()
                    .enumerate()
                    .map(|(i, &a)| (format!("outer[{i}]"), a)),
            );

        for (label, address) in positions {
            if address == DISABLED_ADDRESS {
                continue;
            }
            if !(MIN_VALID_ADDRESS..=MAX_VALID_ADDRESS).contains(&address) {
                return Err(format!(
                    "topology.{label}: address {address:#04x} is outside the legal \
                     i2c slave range {MIN_VALID_ADDRESS:#04x}..={MAX_VALID_ADDRESS:#04x} \
                     (and not the disabled sentinel {DISABLED_ADDRESS:#04x})"
                ));
            }
            if let Some(prev) = seen.insert(address, label.clone()) {
                return Err(format!(
                    "topology: address {address:#04x} is assigned to both {prev} and {label}"
                ));
            }
        }

        Ok(())
    }
}

impl Default for Topology {
    fn default() -> Self {
        Self {
            center: 0x08,
            inner: (0x09..=0x0E).collect(),
            outer: (0x0F..=0x1A).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Driver {
    pub zero_timeout_secs: u64,
    pub extension_tolerance: f64,
    pub refresh_interval_secs: u64,
}

impl Driver {
    pub fn zero_timeout(&self) -> Duration {
        Duration::from_secs(self.zero_timeout_secs)
    }

    pub fn refresh_interval(&self) -> Duration {
        Duration::from_secs(self.refresh_interval_secs)
    }
}

impl Default for Driver {
    fn default() -> Self {
        Self {
            zero_timeout_secs: 60,
            extension_tolerance: 1.0,
            refresh_interval_secs: 1,
        }
    }
}
