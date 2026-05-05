use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::path::Path;
use std::time::Duration;

use figment::Figment;
use figment::providers::Env;
use figment::providers::Format;
use figment::providers::Serialized;
use figment::providers::Toml;
use figment::value::Num;
use figment::value::Value;
use serde::Deserialize;
use serde::Serialize;
use tracing::Level;
use tracing::enabled;
use tracing::event;
use validator::Validate;
use validator::ValidationError;

const CONFIG_LEVEL: Level = Level::INFO;

#[derive(Clone, Debug, Default, Validate, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: Server,

    #[serde(default)]
    pub i2c: I2c,

    #[serde(default)]
    pub driver: Driver,

    #[serde(default)]
    #[validate(custom(function = "validate_topology"))]
    pub topology: Topology,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Server {
    pub host: Ipv4Addr,
    pub port: u16,
}

impl Default for Server {
    fn default() -> Self {
        Self {
            host: Ipv4Addr::UNSPECIFIED,
            port: 5001,
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
#[derive(Debug, Clone, Validate, Serialize, Deserialize)]
pub struct Topology {
    pub center: u16,
    pub inner: Vec<u16>,
    pub outer: Vec<u16>,
}

pub fn validate_topology(topology: &Topology) -> Result<(), ValidationError> {
    use crate::topology::DISABLED_ADDRESS;
    use crate::topology::INNER_COUNT;
    use crate::topology::MAX_VALID_ADDRESS;
    use crate::topology::MIN_VALID_ADDRESS;
    use crate::topology::OUTER_COUNT;

    let inner_expected = INNER_COUNT as usize;
    let outer_expected = OUTER_COUNT as usize;
    if topology.inner.len() != inner_expected {
        return Err(ValidationError::new("topology.inner must have 6 addresses"));
    }
    if topology.outer.len() != outer_expected {
        return Err(ValidationError::new(
            "topology.outer must have 12 addresses",
        ));
    }

    // Walk every position, validating each address against the legal i2c
    // slave range or the disabled sentinel, and ensuring no two enabled
    // positions collide on the same address.
    let mut seen: HashMap<u16, String> = HashMap::new();
    let positions = std::iter::once(("center".to_owned(), topology.center))
        .chain(
            topology
                .inner
                .iter()
                .enumerate()
                .map(|(i, &a)| (format!("inner[{i}]"), a)),
        )
        .chain(
            topology
                .outer
                .iter()
                .enumerate()
                .map(|(i, &a)| (format!("outer[{i}]"), a)),
        );

    for (label, address) in positions {
        if address == DISABLED_ADDRESS {
            continue;
        }
        if !(MIN_VALID_ADDRESS..=MAX_VALID_ADDRESS).contains(&address) {
            return Err(ValidationError::new("All i2c addresses must be 0x08-0x77"));
        }
        if let Some(_) = seen.insert(address, label.clone()) {
            return Err(ValidationError::new("All i2c addresses must be unique"));
        }
    }

    Ok(())
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

/// Render the merged figment as a multi-line, indented view that mirrors the
/// shape of the config, with each leaf annotated by the provider that
/// supplied its value (e.g. ` 0x08 (defaults)`, ` 0x09 (brandelier.toml)`,
/// ` "0.0.0.0" (BRANDELIER__SERVER__HOST env)`).
///
/// Leaves whose key path doesn't exist in `config`'s schema are also tagged
/// `← unknown` — that's typically a typo in TOML / env (`BRANDELIER__SREVER…`)
/// where serde silently dropped the field during extraction.
///
/// Useful as the body of a debug endpoint or as a one-shot dump at startup
/// when you need to answer "where did this value come from?" by eyeball.
pub fn render(figment: &Figment, config: &Config) -> Result<String, Box<figment::Error>> {
    let merged: Value = figment.extract()?;
    // Round-trip the typed config back through figment to get its Value-tree
    // shape — a faithful representation of the keys serde *kept*. Anything
    // present in `merged` but missing from `known` is an unknown key.
    let known: Value = Figment::from(Serialized::defaults(config)).extract()?;
    let mut out = String::new();
    render_value(figment, &merged, Some(&known), 0, &mut out);
    Ok(out)
}

fn render_num(n: &Num) -> String {
    match n {
        Num::U8(v) => v.to_string(),
        Num::U16(v) => v.to_string(),
        Num::U32(v) => v.to_string(),
        Num::U64(v) => v.to_string(),
        Num::U128(v) => v.to_string(),
        Num::USize(v) => v.to_string(),
        Num::I8(v) => v.to_string(),
        Num::I16(v) => v.to_string(),
        Num::I32(v) => v.to_string(),
        Num::I64(v) => v.to_string(),
        Num::I128(v) => v.to_string(),
        Num::ISize(v) => v.to_string(),
        Num::F32(v) => v.to_string(),
        Num::F64(v) => v.to_string(),
    }
}

/// `known` is the same node from the schema-shaped Value tree (or `None`
/// once we've descended into a subtree the schema doesn't know about). When
/// it's `None`, every leaf below gets marked `← unknown`.
fn render_value(fig: &Figment, v: &Value, known: Option<&Value>, indent: usize, out: &mut String) {
    let pad = "    ".repeat(indent);
    let inner_pad = "    ".repeat(indent + 1);
    match v {
        Value::Dict(_, dict) if dict.is_empty() => out.push_str("{}"),
        Value::Dict(_, dict) => {
            out.push_str("{\n");
            for (k, sub) in dict {
                let sub_known = known.and_then(|kv| match kv {
                    Value::Dict(_, kd) => kd.get(k),
                    _ => None,
                });
                out.push_str(&inner_pad);
                out.push_str(k);
                out.push_str(": ");
                render_value(fig, sub, sub_known, indent + 1, out);
                out.push_str(",\n");
            }
            out.push_str(&pad);
            out.push('}');
        }
        Value::Array(_, items) if items.is_empty() => out.push_str("[]"),
        Value::Array(_, items) => {
            out.push_str("[\n");
            for (i, sub) in items.iter().enumerate() {
                let sub_known = known.and_then(|kv| match kv {
                    Value::Array(_, ka) => ka.get(i),
                    _ => None,
                });
                out.push_str(&inner_pad);
                render_value(fig, sub, sub_known, indent + 1, out);
                out.push_str(",\n");
            }
            out.push_str(&pad);
            out.push(']');
        }
        leaf => {
            let value_str = match leaf {
                Value::String(_, s) => format!("{s:?}"),
                Value::Char(_, c) => format!("{c:?}"),
                Value::Bool(_, b) => b.to_string(),
                Value::Num(_, n) => render_num(n),
                Value::Empty(_, _) => "null".to_string(),
                _ => format!("{leaf:?}"),
            };
            let source = fig
                .get_metadata(leaf.tag())
                .map(|m| {
                    m.source
                        .as_ref()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| m.name.to_string())
                })
                .unwrap_or_else(|| "<unknown>".into());
            out.push_str(&value_str);
            out.push_str(" (");
            out.push_str(&source);
            out.push(')');
            if known.is_none() {
                out.push_str(" ← unknown");
            }
        }
    }
}

pub fn load(path: &Path) -> crate::Result<Config> {
    let figment = Figment::new()
        .merge(Serialized::defaults(Config::default()))
        .merge(Toml::file(path))
        .merge(Env::prefixed("BRANDELIER__").split("__"));

    let config: Config = figment
        .extract()
        .expect("Serialized defaults are always available");

    // Sadly, no pydantic-style post-validator in Rust.
    config.validate()?;

    if enabled!(CONFIG_LEVEL) {
        event!(CONFIG_LEVEL, "Loaded configuration");
        println!("{}", render(&figment, &config)?);
    }

    Ok(config)
}
