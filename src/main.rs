use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

use axum::Json;
use axum::Router;
use axum::extract::Path as AxumPath;
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
use crate::driver::BulbStatus;
use crate::driver::ConfigureMaxExt;
use crate::driver::Cycle;
use crate::driver::Driver;
use crate::driver::ReadAll;
use crate::driver::SetAll;
use crate::driver::Stop;
use crate::driver::Zero;
use crate::driver::ZeroSome;
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
    ZeroSomeError(#[from] SendError<ZeroSome, driver::Error>),

    #[error(transparent)]
    ReadAllError(#[from] SendError<ReadAll, driver::Error>),

    #[error(transparent)]
    ConfigureMaxExtError(#[from] SendError<ConfigureMaxExt, driver::Error>),

    #[error(transparent)]
    Io(#[from] io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),
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

const PRESETS_DIR: &str = "presets";
const SETTINGS_FILE: &str = "presets/settings.json";
const GROUPS_FILE: &str = "presets/groups.json";

#[derive(serde::Serialize, serde::Deserialize)]
struct Settings {
    max_length_in: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { max_length_in: 37.0 }
    }
}

fn load_settings() -> Settings {
    std::fs::read_to_string(SETTINGS_FILE)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn safe_preset_path(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\', '.']) {
        return None;
    }
    Some(Path::new(PRESETS_DIR).join(format!("{name}.json")))
}

async fn list_presets() -> Result<Json<Vec<String>>> {
    let dir = Path::new(PRESETS_DIR);
    if !dir.exists() {
        return Ok(Json(vec![]));
    }
    let mut names: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".json")
                .filter(|n| *n != "settings" && *n != "groups")
                .map(str::to_owned)
        })
        .collect();
    names.sort();
    Ok(Json(names))
}

#[derive(serde::Deserialize)]
struct SavePresetBody {
    name: String,
    state: HashMap<BulbId, BulbCommand>,
}

async fn save_preset(Json(body): Json<SavePresetBody>) -> Result<()> {
    let path = safe_preset_path(&body.name)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset name"))?;
    std::fs::create_dir_all(PRESETS_DIR)?;
    std::fs::write(path, serde_json::to_string_pretty(&body.state)?)?;
    Ok(())
}

async fn get_preset(
    AxumPath(name): AxumPath<String>,
) -> Result<Json<HashMap<BulbId, BulbCommand>>> {
    let path = safe_preset_path(&name)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset name"))?;
    let text = std::fs::read_to_string(path)?;
    Ok(Json(serde_json::from_str(&text)?))
}

async fn delete_preset(AxumPath(name): AxumPath<String>) -> Result<()> {
    let path = safe_preset_path(&name)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset name"))?;
    std::fs::remove_file(path)?;
    Ok(())
}

async fn topology(State(AppState { topology, .. }): State<AppState>) -> Json<Vec<BulbSlot>> {
    Json(topology::bulbs(&topology))
}

async fn status(
    State(AppState { driver, .. }): State<AppState>,
) -> Result<Json<HashMap<BulbId, BulbStatus>>> {
    let map = driver.ask(ReadAll).await?;
    Ok(Json(map))
}

async fn zero(
    State(AppState { driver, .. }): State<AppState>,
    Json(bulbs): Json<HashMap<BulbId, BulbCommand>>,
) -> Result<()> {
    driver.ask(ZeroSome { bulbs }).await?;
    Ok(())
}

async fn bulbs(
    State(AppState { driver, .. }): State<AppState>,
    Json(bulbs): Json<HashMap<BulbId, BulbCommand>>,
) -> Result<()> {
    driver.ask(SetAll { bulbs }).await?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct MaxLengthBody {
    inches: f64,
}

async fn get_groups() -> impl IntoResponse {
    let text = std::fs::read_to_string(GROUPS_FILE).unwrap_or_else(|_| "[]".to_string());
    ([(header::CONTENT_TYPE, "application/json")], text)
}

async fn save_groups(Json(body): Json<serde_json::Value>) -> Result<()> {
    std::fs::create_dir_all(PRESETS_DIR)?;
    std::fs::write(GROUPS_FILE, serde_json::to_string_pretty(&body)?)?;
    Ok(())
}

async fn get_settings() -> Result<Json<Settings>> {
    Ok(Json(load_settings()))
}

async fn set_max_length(
    State(AppState { driver, .. }): State<AppState>,
    Json(body): Json<MaxLengthBody>,
) -> Result<()> {
    driver.ask(ConfigureMaxExt { max_in: body.inches }).await?;
    std::fs::create_dir_all(PRESETS_DIR)?;
    std::fs::write(SETTINGS_FILE, serde_json::to_string_pretty(&Settings { max_length_in: body.inches })?)?;
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

    let bus = Bus::spawn(Bus::autodetect(&config.i2c)?);
    let driver = Driver::spawn(Driver::new(&bus, &config.driver, &config.topology));

    driver.ask(ReadAll).await?;

    let settings = load_settings();
    driver.ask(ConfigureMaxExt { max_in: settings.max_length_in }).await?;

    let state = AppState {
        driver,
        topology: config.topology,
    };

    let api = Router::new()
        .route("/topology", get(topology))
        .route("/status", get(status))
        .route("/bulbs", post(bulbs))
        .route("/zero", post(zero))
        .route("/presets", get(list_presets).post(save_preset))
        .route("/presets/{name}", get(get_preset).delete(delete_preset))
        .route("/groups", get(get_groups).post(save_groups))
        .route("/settings", get(get_settings))
        .route("/settings/max-length", post(set_max_length))
        .fallback(|| async { StatusCode::NOT_FOUND });

    let router = Router::new()
        .nest("/api", api)
        .fallback(assets)
        .with_state(state);

    let listener = TcpListener::bind((config.server.host, config.server.port)).await?;

    axum::serve(listener, router).await?;

    Ok(())
}
