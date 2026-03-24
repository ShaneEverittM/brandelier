mod bulb;
mod driver;
mod i2c;

use std::time::Duration;

use kameo::prelude::*;
use tokio::time::sleep;
use tracing_subscriber::EnvFilter;

use crate::driver::Cycle;
use crate::driver::Driver;
use crate::driver::Stop;
use crate::driver::Zero;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    I2C(#[from] i2c::Error),

    #[error(transparent)]
    Driver(#[from] driver::Error),

    #[error(transparent)]
    StopError(#[from] SendError<Stop, driver::Error>),

    #[error(transparent)]
    ZeroError(#[from] SendError<Zero, driver::Error>),

    #[error(transparent)]
    CycleError(#[from] SendError<Cycle, driver::Error>),
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::fmt()
        .pretty()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let driver = Driver::spawn(Driver::new());
    driver.ask(Zero).await?;
    driver.ask(Cycle).await?;
    sleep(Duration::from_secs(30)).await;
    driver.ask(Stop).await?;

    Ok(())
}
