use std::collections::HashMap;
use std::path::PathBuf;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::Uri;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;
use clap::Parser;
use figment::Figment;
use figment::providers::Env;
use figment::providers::Format;
use figment::providers::Serialized;
use figment::providers::Toml;
use kameo::prelude::*;
use rust_embed::Embed;
use tokio::io;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::driver::BulbCommand;
use crate::driver::Cycle;
use crate::driver::Driver;
use crate::driver::SetAll;
use crate::driver::Stop;
use crate::driver::Zero;
use crate::i2c::Bus;
use crate::topology::BulbId;
use crate::topology::BulbSlot;

mod bulb;
mod config;
mod driver;
mod i2c;
mod topology;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    Config(#[from] Box<figment::Error>),

    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    #[error(transparent)]
    Driver(#[from] driver::Error),

    #[error(transparent)]
    StopError(#[from] SendError<Stop, driver::Error>),

    #[error(transparent)]
    ZeroError(#[from] SendError<Zero, driver::Error>),

    #[error(transparent)]
    CycleError(#[from] SendError<Cycle, driver::Error>),

    #[error(transparent)]
    SetAllError(#[from] SendError<SetAll, driver::Error>),

    #[error(transparent)]
    Io(#[from] io::Error),
}

impl IntoResponse for Error {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string()).into_response()
    }
}

#[derive(Parser)]
struct Args {
    /// The path to the config file to use.
    #[clap(long, short)]
    #[clap(default_value = "brandelier.toml")]
    config: PathBuf,
}

#[derive(Clone)]
struct AppState {
    driver: ActorRef<Driver>,
    config: Config,
}

/// Debug endpoint — dumps the loaded config to the server's stdout.
async fn debug_config(State(AppState { config, .. }): State<AppState>) -> Result<()> {
    println!("{config:#?}");
    Ok(())
}

async fn get_topology(State(AppState { config, .. }): State<AppState>) -> Json<Vec<BulbSlot>> {
    Json(topology::bulbs(&config.topology))
}

async fn set_bulbs(
    State(AppState { driver, .. }): State<AppState>,
    Json(bulbs): Json<HashMap<BulbId, BulbCommand>>,
) -> Result<()> {
    driver.ask(SetAll { bulbs }).await?;
    Ok(())
}

/// Static UI assets bundled at compile time.
///
/// In release builds these are baked into the binary (single artifact for
/// scp'ing to the Pi). In debug builds rust-embed reads from disk on each
/// request, so editing `ui/dist/` while the dev binary is running picks up
/// changes without a rebuild — though normally you'll be running Vite on
/// :5173 and proxying `/api` to this server during development.
///
/// `ui/dist/` must exist at compile time; produce it with `bun run build`
/// (or symlink it to a placeholder for early dev).
#[derive(Embed)]
#[folder = "ui/dist/"]
struct Assets;

async fn serve_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response();
    }

    // Unknown path → fall through to index.html so client-side routing works.
    match Assets::get("index.html") {
        Some(file) => {
            ([(header::CONTENT_TYPE, "text/html")], file.data).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::fmt()
        .pretty()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let args = Args::parse();

    let config: Config = Figment::new()
        .merge(Serialized::defaults(Config::default()))
        .merge(Toml::file(args.config))
        .merge(Env::prefixed("BRANDELIER__").split("__"))
        .extract()
        .expect("Serialized defaults are always available");

    config.topology.validate().map_err(Error::InvalidConfig)?;

    #[cfg(any(target_os = "linux", target_os = "android"))]
    let i2c = i2c::LinuxBus::new(&config.i2c.device_path)?;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let i2c = i2c::MockBus::new();

    let bus = Bus::spawn(Bus::new(Box::new(i2c), &config.i2c));
    let driver = Driver::spawn(Driver::new(
        bus,
        config.driver.clone(),
        config.topology.clone(),
    ));
    let state = AppState {
        driver,
        config: config.clone(),
    };

    let router = Router::new()
        .route("/api/debug/config", get(debug_config))
        .route("/api/topology", get(get_topology))
        .route("/api/bulbs", post(set_bulbs))
        .with_state(state)
        .fallback(serve_static);
    let listener = TcpListener::bind((config.server.host, config.server.port)).await?;

    axum::serve(listener, router).await?;

    Ok(())
}
