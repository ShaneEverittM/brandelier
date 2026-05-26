use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
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
mod wave;

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

struct WaveRunState {
    token: CancellationToken,
    started_at: f64,
    config: wave::StartWaveRequest,
}

struct DisabledAllSave {
    wave_config: Option<wave::StartWaveRequest>,
    wave_elapsed_at_save: f64,
    dimmer: f64,
}

struct DisableAllCtrl {
    disabled: bool,
    prev_any_disable_all: bool,
    saved: Option<DisabledAllSave>,
}

#[derive(Clone)]
struct AppState {
    driver: ActorRef<Driver>,
    topology: config::Topology,
    wave: Arc<Mutex<Option<WaveRunState>>>,
    dimmer: Arc<Mutex<f64>>,
    disable_ctrl: Arc<Mutex<DisableAllCtrl>>,
}

const POSITION_PRESETS_DIR: &str = "presets/position";
const BRIGHTNESS_PRESETS_DIR: &str = "presets/brightness";
const WAVE_PRESETS_DIR: &str = "presets/wave";
const SETTINGS_FILE: &str = "presets/settings.json";
const GROUPS_FILE: &str = "presets/groups.json";

#[derive(serde::Serialize, serde::Deserialize)]
struct Settings {
    max_length_in: f64,
    #[serde(default = "Settings::default_dimmer")]
    dimmer: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_length_in: 37.0,
            dimmer: 1.0,
        }
    }
}

impl Settings {
    fn default_dimmer() -> f64 {
        1.0
    }
}

fn load_settings() -> Settings {
    std::fs::read_to_string(SETTINGS_FILE)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn preset_dir(kind: &str) -> Option<&'static str> {
    match kind {
        "position" => Some(POSITION_PRESETS_DIR),
        "brightness" => Some(BRIGHTNESS_PRESETS_DIR),
        "wave" => Some(WAVE_PRESETS_DIR),
        _ => None,
    }
}

fn safe_preset_path(dir: &str, name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\', '.']) {
        return None;
    }
    Some(Path::new(dir).join(format!("{name}.json")))
}

async fn list_presets_kind(AxumPath(kind): AxumPath<String>) -> Result<Json<Vec<String>>> {
    let dir = preset_dir(&kind)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset kind"))?;
    let dir = Path::new(dir);
    if !dir.exists() {
        return Ok(Json(vec![]));
    }
    let mut names: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".json").map(str::to_owned)
        })
        .collect();
    names.sort();
    Ok(Json(names))
}

#[derive(serde::Deserialize)]
struct SavePresetBody {
    name: String,
    state: serde_json::Value,
}

async fn save_preset_kind(
    AxumPath(kind): AxumPath<String>,
    Json(body): Json<SavePresetBody>,
) -> Result<()> {
    let dir = preset_dir(&kind)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset kind"))?;
    let path = safe_preset_path(dir, &body.name)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset name"))?;
    std::fs::create_dir_all(dir)?;
    std::fs::write(path, serde_json::to_string_pretty(&body.state)?)?;
    Ok(())
}

async fn get_preset_kind(
    AxumPath((kind, name)): AxumPath<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    let dir = preset_dir(&kind)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset kind"))?;
    let path = safe_preset_path(dir, &name)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset name"))?;
    let text = std::fs::read_to_string(path)?;
    Ok(Json(serde_json::from_str(&text)?))
}

async fn delete_preset_kind(AxumPath((kind, name)): AxumPath<(String, String)>) -> Result<()> {
    let dir = preset_dir(&kind)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset kind"))?;
    let path = safe_preset_path(dir, &name)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid preset name"))?;
    std::fs::remove_file(path)?;
    Ok(())
}

async fn set_dimmer_live(
    State(AppState { dimmer, .. }): State<AppState>,
    Json(body): Json<DimmerBody>,
) -> Result<()> {
    *dimmer.lock().unwrap() = body.dimmer.clamp(0.0, 1.0);
    Ok(())
}

async fn wave_start(
    State(AppState {
        driver,
        wave,
        dimmer,
        ..
    }): State<AppState>,
    Json(req): Json<wave::StartWaveRequest>,
) -> Result<Json<wave::WaveStarted>> {
    // Cancel any previously running wave.
    if let Some(old) = wave.lock().unwrap().take() {
        old.token.cancel();
    }

    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    // Adjust epoch anchor so t=0 lines up with the elapsed offset the client sent.
    let started_at = now_unix - req.elapsed;

    let token = CancellationToken::new();
    let start = Instant::now();

    let config = req.clone();
    tokio::spawn(wave::run(driver, req, token.clone(), start, dimmer));

    *wave.lock().unwrap() = Some(WaveRunState {
        token,
        started_at,
        config,
    });

    Ok(Json(wave::WaveStarted { started_at }))
}

async fn wave_stop(State(AppState { wave, .. }): State<AppState>) {
    if let Some(old) = wave.lock().unwrap().take() {
        old.token.cancel();
    }
}

async fn wave_status(State(AppState { wave, .. }): State<AppState>) -> Json<wave::WaveStatus> {
    let guard = wave.lock().unwrap();
    match &*guard {
        Some(s) => Json(wave::WaveStatus {
            running: true,
            started_at: Some(s.started_at),
            config: Some(s.config.clone()),
        }),
        None => Json(wave::WaveStatus {
            running: false,
            started_at: None,
            config: None,
        }),
    }
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
    std::fs::create_dir_all("presets")?;
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
    driver
        .ask(ConfigureMaxExt {
            max_in: body.inches,
        })
        .await?;
    let mut settings = load_settings();
    settings.max_length_in = body.inches;
    std::fs::create_dir_all("presets")?;
    std::fs::write(SETTINGS_FILE, serde_json::to_string_pretty(&settings)?)?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct DimmerBody {
    dimmer: f64,
}

async fn set_dimmer(
    State(AppState { dimmer, .. }): State<AppState>,
    Json(body): Json<DimmerBody>,
) -> Result<()> {
    *dimmer.lock().unwrap() = body.dimmer.clamp(0.0, 1.0);
    let mut settings = load_settings();
    settings.dimmer = body.dimmer;
    std::fs::create_dir_all("presets")?;
    std::fs::write(SETTINGS_FILE, serde_json::to_string_pretty(&settings)?)?;
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

async fn enter_disable(
    driver: &ActorRef<Driver>,
    wave: &Arc<Mutex<Option<WaveRunState>>>,
    dimmer: &Arc<Mutex<f64>>,
    disable_ctrl: &Arc<Mutex<DisableAllCtrl>>,
    status: &HashMap<BulbId, BulbStatus>,
) {
    let current_dimmer = *dimmer.lock().unwrap();
    let (wave_config, wave_elapsed_at_save) = {
        let guard = wave.lock().unwrap();
        if let Some(w) = guard.as_ref() {
            let now_unix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();
            (Some(w.config.clone()), now_unix - w.started_at)
        } else {
            (None, 0.0)
        }
    };
    if let Some(old) = wave.lock().unwrap().take() {
        old.token.cancel();
    }
    {
        let mut ctrl = disable_ctrl.lock().unwrap();
        ctrl.disabled = true;
        ctrl.saved = Some(DisabledAllSave { wave_config, wave_elapsed_at_save, dimmer: current_dimmer });
    }
    *dimmer.lock().unwrap() = 0.0;
    let all_zero: HashMap<BulbId, BulbCommand> = status
        .iter()
        .map(|(id, s)| (id.clone(), BulbCommand { pos: s.pos, bright: 0.0 }))
        .collect();
    let _ = driver.ask(SetAll { bulbs: all_zero }).await;
}

async fn restore_from_disable(
    driver: &ActorRef<Driver>,
    wave: &Arc<Mutex<Option<WaveRunState>>>,
    dimmer: &Arc<Mutex<f64>>,
    disable_ctrl: &Arc<Mutex<DisableAllCtrl>>,
) {
    let saved = {
        let mut ctrl = disable_ctrl.lock().unwrap();
        if !ctrl.disabled {
            return;
        }
        ctrl.disabled = false;
        ctrl.saved.take()
    };
    let Some(save) = saved else { return };
    *dimmer.lock().unwrap() = save.dimmer;
    if let Some(mut wave_req) = save.wave_config {
        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        wave_req.elapsed = save.wave_elapsed_at_save;
        let started_at = now_unix - save.wave_elapsed_at_save;
        let token = CancellationToken::new();
        let start = Instant::now();
        let config = wave_req.clone();
        tokio::spawn(wave::run(driver.clone(), wave_req, token.clone(), start, dimmer.clone()));
        *wave.lock().unwrap() = Some(WaveRunState { token, started_at, config });
    }
}

async fn disable_all_monitor(
    driver: ActorRef<Driver>,
    wave: Arc<Mutex<Option<WaveRunState>>>,
    dimmer: Arc<Mutex<f64>>,
    disable_ctrl: Arc<Mutex<DisableAllCtrl>>,
) {
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let Ok(status) = driver.ask(ReadAll).await else { continue };
        let any_disable_all = status.values().any(|s| s.disabled);
        let rising_edge = {
            let mut ctrl = disable_ctrl.lock().unwrap();
            let edge = any_disable_all && !ctrl.prev_any_disable_all;
            ctrl.prev_any_disable_all = any_disable_all;
            edge
        };
        if !rising_edge {
            continue;
        }
        if disable_ctrl.lock().unwrap().disabled {
            restore_from_disable(&driver, &wave, &dimmer, &disable_ctrl).await;
        } else {
            enter_disable(&driver, &wave, &dimmer, &disable_ctrl, &status).await;
        }
    }
}

#[derive(serde::Serialize)]
struct DisableAllStatus {
    disabled: bool,
}

async fn get_disable_all(
    State(AppState { disable_ctrl, .. }): State<AppState>,
) -> Json<DisableAllStatus> {
    let disabled = disable_ctrl.lock().unwrap().disabled;
    Json(DisableAllStatus { disabled })
}

async fn post_disable_all(
    State(AppState { driver, wave, dimmer, disable_ctrl, .. }): State<AppState>,
) {
    restore_from_disable(&driver, &wave, &dimmer, &disable_ctrl).await;
}

async fn post_trigger_disable(
    State(AppState { driver, wave, dimmer, disable_ctrl, .. }): State<AppState>,
) {
    if disable_ctrl.lock().unwrap().disabled {
        return;
    }
    let Ok(status) = driver.ask(ReadAll).await else { return };
    enter_disable(&driver, &wave, &dimmer, &disable_ctrl, &status).await;
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
    driver
        .ask(ConfigureMaxExt {
            max_in: settings.max_length_in,
        })
        .await?;

    let disable_ctrl = Arc::new(Mutex::new(DisableAllCtrl {
        disabled: false,
        prev_any_disable_all: false,
        saved: None,
    }));

    let state = AppState {
        driver: driver.clone(),
        topology: config.topology,
        wave: Arc::new(Mutex::new(None)),
        dimmer: Arc::new(Mutex::new(settings.dimmer)),
        disable_ctrl: disable_ctrl.clone(),
    };

    tokio::spawn(disable_all_monitor(
        driver,
        state.wave.clone(),
        state.dimmer.clone(),
        disable_ctrl,
    ));

    let api = Router::new()
        .route("/topology", get(topology))
        .route("/status", get(status))
        .route("/bulbs", post(bulbs))
        .route("/zero", post(zero))
        .route("/wave", get(wave_status).post(wave_start).delete(wave_stop))
        .route("/disable-all", get(get_disable_all).post(post_disable_all))
        .route("/disable", post(post_trigger_disable))
        .route("/dimmer", post(set_dimmer_live))
        .route(
            "/presets/{kind}",
            get(list_presets_kind).post(save_preset_kind),
        )
        .route(
            "/presets/{kind}/{name}",
            get(get_preset_kind).delete(delete_preset_kind),
        )
        .route("/groups", get(get_groups).post(save_groups))
        .route("/settings", get(get_settings))
        .route("/settings/max-length", post(set_max_length))
        .route("/settings/dimmer", post(set_dimmer))
        .fallback(|| async { StatusCode::NOT_FOUND });

    let router = Router::new()
        .nest("/api", api)
        .fallback(assets)
        .with_state(state);

    let listener = TcpListener::bind((config.server.host, config.server.port)).await?;

    axum::serve(listener, router).await?;

    Ok(())
}
