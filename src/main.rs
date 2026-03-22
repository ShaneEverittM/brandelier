mod bulb;
mod driver;
mod i2c;

use crate::bulb::Bulb;
use crate::driver::Driver;
use tracing_subscriber::EnvFilter;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    I2C(#[from] i2c::Error),

    #[error(transparent)]
    Driver(#[from] driver::Error),
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::fmt()
        .pretty()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let bus = i2c::get_bus()?;
    let bulbs = i2c::get_addresses()?
        .map(|(pos, addr)| (pos, Bulb::new(bus.clone(), addr, 1.0)))
        .collect();

    let mut driver = Driver::new(
        bulbs,
        |x, _, t| (3.0 * (0.25 * x + 0.25 * t).sin()) + 4.0,
        |x, _, t| (16.0 * (0.25 * x + 0.25 * t).sin()) + 20.0,
    );
    driver.zero().await?;
    driver.cycle().await?;

    Ok(())
}
