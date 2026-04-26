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
    pub base_address: u16,
    pub num_devices: u16,
    pub device_spacing: f64,
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
            base_address: 0x08,
            num_devices: 5,
            device_spacing: 4.0,
            retries: 3,
            retry_delay_ms: 20,
            rate_limit_ms: 40,
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
