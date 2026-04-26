use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use figment::Figment;
use figment::providers::Env;
use figment::providers::Format;
use figment::providers::Serialized;
use figment::providers::Toml;
use kameo::prelude::*;
use tokio::io;
use tokio::net::TcpListener;
use tower_http::services::ServeDir;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::driver::Cycle;
use crate::driver::Driver;
use crate::driver::Stop;
use crate::driver::Zero;
use crate::i2c::Bus;

mod bulb;
mod config;
mod driver;
mod i2c;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    Config(#[from] Box<figment::Error>),

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

impl IntoResponse for Error {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string()).into_response()
    }
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

    let config: Config = Figment::from(Serialized::defaults(Config::default()))
        .merge(Toml::file("brandelier.toml"))
        .merge(Env::prefixed("BRANDELIER__").split("__"))
        .extract()
        .expect("Serialized defaults are always available");

    #[cfg(any(target_os = "linux", target_os = "android"))]
    let i2c = i2c::LinuxBus::new(&config.i2c.device_path)?;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let i2c = i2c::MockBus::new();

    let bus = Bus::spawn(Bus::new(Box::new(i2c), &config.i2c));
    let driver = Driver::spawn(Driver::new(bus, config.driver, config.i2c));
    let state = AppState { driver };

    let router = Router::new()
        .route("/", get(index))
        .with_state(state)
        .fallback_service(ServeDir::new(&config.server.static_dir));
    let listener = TcpListener::bind((config.server.host, config.server.port)).await?;

    axum::serve(listener, router).await?;

    Ok(())
}
