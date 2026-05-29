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
use tracing::error;
use tracing_subscriber::EnvFilter;
use validator::ValidationErrors;

use crate::driver::BulbCommand;
use crate::driver::BulbStatus;
use crate::driver::ConfigureMaxExt;
use crate::driver::Cycle;
use crate::driver::Driver;
use crate::driver::ReadAll;
use crate::driver::SetAll;
use crate::driver::SetStartBrightness;
use crate::driver::TellPositions;
use crate::driver::Stop;
use crate::driver::Zero;
use crate::driver::ZeroSome;
use crate::driver::ToggleLightSome;
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
    ToggleLightSomeError(#[from] SendError<ToggleLightSome, driver::Error>),

    #[error(transparent)]
    ReadAllError(#[from] SendError<ReadAll, driver::Error>),

    #[error(transparent)]
    ConfigureMaxExtError(#[from] SendError<ConfigureMaxExt, driver::Error>),

    #[error(transparent)]
    TellPositionsError(#[from] SendError<TellPositions, driver::Error>),

    #[error(transparent)]
    SetStartBrightnessError(#[from] SendError<SetStartBrightness, driver::Error>),

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
    position_store: Arc<Mutex<PositionStore>>,
}

const POSITION_STORE_FILE: &str = "presets/positions.json";
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
    #[serde(default = "Settings::default_startup_brightness")]
    startup_brightness: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_length_in: 10.0,
            dimmer: 1.0,
            startup_brightness: 1.0,
        }
    }
}

impl Settings {
    fn default_dimmer() -> f64 {
        1.0
    }
    fn default_startup_brightness() -> f64 {
        1.0
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct PositionStore {
    bulbs_moving: bool,
    #[serde(default)]
    positions: HashMap<BulbId, f64>,
}

impl Default for PositionStore {
    fn default() -> Self {
        Self { bulbs_moving: true, positions: HashMap::new() }
    }
}

impl PositionStore {
    fn load() -> Self {
        std::fs::read_to_string(POSITION_STORE_FILE)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::create_dir_all("presets");
            if let Err(e) = std::fs::write(POSITION_STORE_FILE, s) {
                error!("Failed to save position store: {e}");
            }
        }
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
        position_store,
        ..
    }): State<AppState>,
    Json(req): Json<wave::StartWaveRequest>,
) -> Result<Json<wave::WaveStarted>> {
    if req.waves.iter().any(|w| w.target == wave::WaveTarget::Extension) {
        let mut store = position_store.lock().unwrap();
        if !store.bulbs_moving {
            store.bulbs_moving = true;
            store.save();
        }
    }
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
    State(AppState { driver, position_store, .. }): State<AppState>,
    Json(bulbs): Json<HashMap<BulbId, BulbCommand>>,
) -> Result<()> {
    {
        let mut store = position_store.lock().unwrap();
        if !store.bulbs_moving {
            store.bulbs_moving = true;
            store.save();
        }
    }
    driver.ask(ZeroSome { bulbs }).await?;
    Ok(())
}

async fn toggle_light(
    State(AppState { driver, .. }): State<AppState>,
    Json(ids): Json<Vec<BulbId>>,
) -> Result<()> {
    driver.ask(ToggleLightSome { ids }).await?;
    Ok(())
}

async fn bulbs(
    State(AppState { driver, position_store, .. }): State<AppState>,
    Json(bulbs): Json<HashMap<BulbId, BulbCommand>>,
) -> Result<()> {
    {
        let mut store = position_store.lock().unwrap();
        if !store.bulbs_moving {
            store.bulbs_moving = true;
            store.save();
        }
    }
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

#[derive(serde::Deserialize)]
struct StartupBrightnessBody {
    brightness: f64,
}

async fn set_startup_brightness(
    State(AppState { driver, .. }): State<AppState>,
    Json(body): Json<StartupBrightnessBody>,
) -> Result<()> {
    driver
        .ask(SetStartBrightness {
            brightness: body.brightness,
        })
        .await?;
    let mut settings = load_settings();
    settings.startup_brightness = body.brightness;
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
) {
    let current_dimmer = *dimmer.lock().unwrap();
    *dimmer.lock().unwrap() = 0.0;
    let (wave_config, wave_elapsed_at_save) = {
        let mut guard = wave.lock().unwrap();
        if let Some(w) = guard.take() {
            let now_unix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();
            let elapsed = now_unix - w.started_at;
            w.token.cancel();
            (Some(w.config), elapsed)
        } else {
            (None, 0.0)
        }
    };
    let status = driver.ask(ReadAll).await.unwrap_or_default();
    let all_dark: HashMap<BulbId, BulbCommand> = status
        .into_iter()
        .map(|(id, s)| (id, BulbCommand { pos: s.pos, bright: 0.0 }))
        .collect();
    let _ = driver.ask(SetAll { bulbs: all_dark }).await;
    {
        let mut ctrl = disable_ctrl.lock().unwrap();
        ctrl.disabled = true;
        ctrl.saved = Some(DisabledAllSave { wave_config, wave_elapsed_at_save, dimmer: current_dimmer });
    }
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
            enter_disable(&driver, &wave, &dimmer, &disable_ctrl).await;
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
    enter_disable(&driver, &wave, &dimmer, &disable_ctrl).await;
}

async fn position_monitor(
    driver: ActorRef<Driver>,
    wave: Arc<Mutex<Option<WaveRunState>>>,
    position_store: Arc<Mutex<PositionStore>>,
) {
    let mut all_stopped_since: Option<Instant> = None;

    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;

        // While a wave is running, bulbs are moving — skip polling.
        if wave.lock().unwrap().is_some() {
            all_stopped_since = None;
            continue;
        }

        let Ok(status) = driver.ask(ReadAll).await else {
            continue;
        };

        let any_moving = status.values().any(|s| s.speed > 0.0);

        if any_moving {
            all_stopped_since = None;
            let mut store = position_store.lock().unwrap();
            if !store.bulbs_moving {
                store.bulbs_moving = true;
                store.save();
            }
        } else {
            let now = Instant::now();
            let since = all_stopped_since.get_or_insert(now);
            if now.duration_since(*since) >= Duration::from_millis(100) {
                let mut store = position_store.lock().unwrap();
                if store.bulbs_moving {
                    store.positions = status.into_iter().map(|(id, s)| (id, s.pos)).collect();
                    store.bulbs_moving = false;
                    store.save();
                }
                all_stopped_since = None;
            }
        }
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

    let settings = load_settings();

    let position_store_data = PositionStore::load();
    let needs_zero = position_store_data.bulbs_moving || position_store_data.positions.is_empty();

    {
        let driver = driver.clone();
        let positions = position_store_data.positions.clone();
        let max_in = settings.max_length_in;
        tokio::spawn(async move {
            if needs_zero {
                if let Err(e) = driver.ask(Zero).await {
                    tracing::error!("Startup zero failed: {e}");
                    return;
                }
                if let Err(e) = driver.ask(ConfigureMaxExt { max_in }).await {
                    tracing::error!("Startup configure failed: {e}");
                }
            } else if let Err(e) = driver.ask(TellPositions { positions, max_in }).await {
                tracing::error!("Startup tell-positions failed: {e}");
            }
        });
    }

    let position_store = Arc::new(Mutex::new(position_store_data));

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
        position_store: position_store.clone(),
    };

    tokio::spawn(disable_all_monitor(
        driver.clone(),
        state.wave.clone(),
        state.dimmer.clone(),
        disable_ctrl,
    ));

    tokio::spawn(position_monitor(
        driver,
        state.wave.clone(),
        position_store,
    ));

    let api = Router::new()
        .route("/topology", get(topology))
        .route("/status", get(status))
        .route("/bulbs", post(bulbs))
        .route("/zero", post(zero))
        .route("/toggle-light", post(toggle_light))
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
        .route("/settings/startup-brightness", post(set_startup_brightness))
        .fallback(|| async { StatusCode::NOT_FOUND });

    let router = Router::new()
        .nest("/api", api)
        .fallback(assets)
        .with_state(state);

    let listener = TcpListener::bind((config.server.host, config.server.port)).await?;

    axum::serve(listener, router).await?;

    Ok(())
}
