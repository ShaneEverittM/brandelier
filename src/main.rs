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
use kameo::prelude::*;
use rust_embed::Embed;
use tokio::io;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use validator::ValidationErrors;

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
    InvalidConfig(#[from] ValidationErrors),

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
    fn into_response(self) -> Response {
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
    topology: config::Topology,
}

async fn topology(State(AppState { topology, .. }): State<AppState>) -> Json<Vec<BulbSlot>> {
    Json(topology::bulbs(&topology))
}

async fn bulbs(
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

/// Get bundled SPA assets.
async fn assets(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = Assets::get(path) {
        return match mime_guess::from_path(path).first() {
            None => file.data.into_response(),
            Some(mime) => ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response(),
        };
    }

    // Unknown path → fall through to index.html so client-side routing works.
    match Assets::get("index.html") {
        Some(file) => ([(header::CONTENT_TYPE, "text/html")], file.data).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn init_tracing() {
    tracing_subscriber::fmt::fmt()
        .pretty()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let args = Args::parse();

    let config = config::load(&args.config)?;

    let bus = Bus::spawn(Bus::autodetect(&config.i2c));
    let driver = Driver::spawn(Driver::new(&bus, &config.driver, &config.topology));

    let state = AppState {
        driver,
        topology: config.topology,
    };

    let api = Router::new()
        .route("/topology", get(topology))
        .route("/bulbs", post(bulbs))
        .fallback(|| async { StatusCode::NOT_FOUND });

    let router = Router::new()
        .nest("/api", api)
        .fallback(assets)
        .with_state(state);

    let listener = TcpListener::bind((config.server.host, config.server.port)).await?;

    axum::serve(listener, router).await?;

    Ok(())
}
