use std::net::Ipv4Addr;

use axum::Router;
use axum::extract::State;
use axum::routing::get;
use kameo::prelude::*;
use tokio::io;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::driver::Cycle;
use crate::driver::Driver;
use crate::driver::Stop;
use crate::driver::Zero;

mod bulb;
mod driver;
mod i2c;

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

    #[error(transparent)]
    Io(#[from] io::Error),
}

#[derive(Clone)]
struct AppState {
    driver: ActorRef<Driver>,
}

async fn index(State(AppState { driver }): State<AppState>) -> Result<()> {
    driver.ask(Zero).await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::fmt()
        .pretty()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let driver = Driver::spawn(Driver::new());
    let state = AppState { driver };

    let router = Router::new().route("/", get(index)).with_state(state);
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 5000)).await?;

    axum::serve(listener, router).await?;

    Ok(())
}
