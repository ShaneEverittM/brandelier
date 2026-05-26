use std::collections::HashMap;
use std::mem::replace;
use std::time::Duration;

use kameo::error::Infallible;
use kameo::mailbox::Signal;
use kameo::prelude::*;
use kameo::reply::DelegatedReply;
use kameo::reply::ReplySender;
use serde::Deserialize;
use serde::Serialize;
use tokio::select;
use tokio::task;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::error;
use tracing::info;
use tracing::warn;

use crate::bulb;
use crate::bulb::Bulb;
use crate::bulb::Command;
use crate::config;
use crate::i2c;
use crate::topology;
use crate::topology::BulbId;

/// Mapping from a normalized [0, 1] cord-drop ratio to physical extension (inches)
/// and from normalized [0, 1] brightness to the 0..255 byte the firmware
/// expects.
const MAX_EXTENSION: f64 = 100.0;
const MAX_BRIGHTNESS: f64 = 255.0;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("Error interacting with bulb: '{0}'")]
    Bulb(#[from] bulb::Error),

    #[error("Timed out zeroing")]
    ZeroTimeout,

    #[error("Background task panicked")]
    TaskJoin(#[from] task::JoinError),

    #[error("Background task failed: {0}")]
    BackgroundTaskFailed(String),
}

pub struct State {
    bulbs: HashMap<BulbId, Bulb>,
    zero_timeout: Duration,
    refresh_interval: Duration,
}

impl State {
    pub async fn cycle(mut self, token: CancellationToken) -> Result<Self> {
        let cycle = async {
            let settle_time = Duration::from_secs(5);
            let start_t = Instant::now();
            let mut last_check = None;

            loop {
                let now = Instant::now();
                let t = (now - start_t).as_secs_f64();

                for bulb in self.bulbs.values_mut() {
                    let position = bulb.position();
                    let extension = (3.0 * (0.25 * *position.x + 0.25 * t).sin()) + 4.0;
                    let brightness = (16.0 * (0.25 * *position.x + 0.25 * t).sin()) + 20.0;
                    bulb.write(Command::SetBrightness {
                        extension,
                        brightness,
                    })
                    .await?;
                }

                if let Some(last) = last_check
                    && now - last > self.refresh_interval
                {
                    for bulb in &mut self.bulbs.values_mut() {
                        let settled = now - start_t > settle_time;
                        bulb.refresh(settled).await?;
                    }
                    last_check = Some(now);
                }
            }

            #[expect(unreachable_code, reason = "Needed for type inference")]
            Ok::<(), Error>(())
        };

        token.run_until_cancelled(cycle).await;

        Ok(self)
    }

    pub async fn zero(mut self) -> Result<Self> {
        for bulb in self.bulbs.values_mut() {
            bulb.write(Command::SetMaxExtension {
                extension: 0.0,
                max: 65.0,
            })
            .await?;
            bulb.zero().await?;
            bulb.refresh(false).await?;
            info!(zeroing = bulb.zeroing(), "Bulb post refresh");
        }

        let zero = async {
            while self.bulbs.values().any(Bulb::zeroing) {
                for bulb in self.bulbs.values_mut() {
                    bulb.refresh(false).await?;
                }
            }
            info!("Finished zeroing!");

            Ok::<(), Error>(())
        };
        match timeout(self.zero_timeout, zero).await {
            Ok(Ok(())) => {}
            Err(_) => return Err(Error::ZeroTimeout),
            Ok(Err(e)) => return Err(e),
        }

        Ok(self)
    }
}

enum Mode {
    Uninitialized,
    Idle {
        state: State,
    },
    Zeroing {
        zeroing: JoinHandle<Result<State>>,
    },
    Cycling {
        token: CancellationToken,
        cycle: JoinHandle<Result<State>>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct BulbStatus {
    pub pos: f64,
    pub light_on: bool,
    pub zeroing: bool,
    pub disabled: bool,
    pub eeprom_error: bool,
    pub max_speed_warn: bool,
    pub drift_detected: bool,
}

pub struct Driver {
    mode: Mode,
    waiters: Vec<ReplySender<Result<()>>>,
    bus: ActorRef<i2c::Bus>,
    config: config::Driver,
    topology: config::Topology,
    last_status: HashMap<BulbId, BulbStatus>,
    max_extension: f64,
}

impl Actor for Driver {
    type Args = Self;
    type Error = Infallible;

    async fn on_start(args: Self::Args, _: ActorRef<Self>) -> Result<Self, Self::Error> {
        Ok(args)
    }

    async fn next(
        &mut self,
        _: WeakActorRef<Self>,
        mailbox_rx: &mut MailboxReceiver<Self>,
    ) -> Option<Signal<Self>> {
        loop {
            let (Mode::Zeroing { zeroing: task } | Mode::Cycling { cycle: task, .. }) =
                &mut self.mode
            else {
                return mailbox_rx.recv().await;
            };

            let task_result = select! {
                signal = mailbox_rx.recv() => return signal,
                result = task => result,
            };

            match task_result {
                Ok(Ok(state)) => {
                    self.mode = Mode::Idle { state };
                    self.notify_waiters(Ok(()));
                }
                Err(error) => {
                    error!(?error, "Background task panicked");
                    self.notify_waiters(Err(Error::BackgroundTaskFailed(error.to_string())));
                }
                Ok(Err(error)) => {
                    error!(?error, "Background operation failed, reinitializing");
                    self.notify_waiters(Err(Error::BackgroundTaskFailed(error.to_string())));
                }
            }
        }
    }
}

pub struct Zero;

impl Message<Zero> for Driver {
    type Reply = Result<()>;

    async fn handle(&mut self, _: Zero, _: &mut Context<Self, Self::Reply>) -> Result<()> {
        let state = self.idle().await?;
        let zeroing = task::spawn(state.zero());
        self.mode = Mode::Zeroing { zeroing };

        Ok(())
    }
}

pub struct Cycle;

impl Message<Cycle> for Driver {
    type Reply = Result<()>;

    async fn handle(&mut self, _: Cycle, _: &mut Context<Self, Self::Reply>) -> Result<()> {
        let state = self.idle().await?;
        let token = CancellationToken::new();
        let cycle = task::spawn(state.cycle(token.clone()));
        self.mode = Mode::Cycling { token, cycle };

        Ok(())
    }
}

/// Per-bulb desired state. `pos` and `bright` are normalized [0, 1].
#[derive(Debug, Deserialize, Serialize)]
pub struct BulbCommand {
    pub pos: f64,
    pub bright: f64,
}

/// Assert the desired state of every bulb in one batch. Cancels any running
/// cycle and stays idle afterward. Bulb IDs not present in the driver's
/// active set (e.g. disabled) are silently skipped.
pub struct SetAll {
    pub bulbs: HashMap<BulbId, BulbCommand>,
}

impl Message<SetAll> for Driver {
    type Reply = Result<()>;

    async fn handle(&mut self, msg: SetAll, _: &mut Context<Self, Self::Reply>) -> Result<()> {
        let mut state = self.idle().await?;
        for (id, cmd) in msg.bulbs {
            let Some(bulb) = state.bulbs.get_mut(&id) else {
                continue;
            };
            let extension = cmd.pos.clamp(0.0, 1.0) * self.max_extension;
            let brightness = cmd.bright.clamp(0.0, 1.0) * MAX_BRIGHTNESS;
            bulb.write(Command::SetBrightness {
                extension,
                brightness,
            })
            .await?;
        }
        self.mode = Mode::Idle { state };
        self.notify_waiters(Ok(()));
        Ok(())
    }
}

pub struct ZeroSome {
    pub bulbs: HashMap<BulbId, BulbCommand>,
}

impl Message<ZeroSome> for Driver {
    type Reply = Result<()>;

    async fn handle(&mut self, msg: ZeroSome, _: &mut Context<Self, Self::Reply>) -> Result<()> {
        let mut state = self.idle().await?;
        for (id, cmd) in msg.bulbs {
            let Some(bulb) = state.bulbs.get_mut(&id) else {
                continue;
            };
            let extension = cmd.pos.clamp(0.0, 1.0) * self.max_extension;
            bulb.write(Command::Zero { extension }).await?;
        }
        self.mode = Mode::Idle { state };
        self.notify_waiters(Ok(()));
        Ok(())
    }
}

pub struct Stop;

impl Message<Stop> for Driver {
    type Reply = Result<()>;

    async fn handle(&mut self, _: Stop, _: &mut Context<Self, Self::Reply>) -> Result<()> {
        let state = self.idle().await?;
        self.mode = Mode::Idle { state };
        self.notify_waiters(Ok(()));
        Ok(())
    }
}

pub struct WaitForIdle;

impl Message<WaitForIdle> for Driver {
    type Reply = DelegatedReply<Result<()>>;

    async fn handle(
        &mut self,
        _: WaitForIdle,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let (delegated, sender) = ctx.reply_sender();
        match sender {
            Some(tx) if matches!(self.mode, Mode::Uninitialized | Mode::Idle { .. }) => {
                tx.send(Ok(()));
            }
            Some(tx) => {
                self.waiters.push(tx);
            }
            None => {
                warn!("Sender requested to wait for Idle via a TellRequest")
            }
        }
        delegated
    }
}

pub struct ReadAll;

impl Message<ReadAll> for Driver {
    type Reply = Result<HashMap<BulbId, BulbStatus>>;

    async fn handle(&mut self, _: ReadAll, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        let can_refresh = matches!(self.mode, Mode::Idle { .. } | Mode::Uninitialized);
        let is_zeroing = matches!(self.mode, Mode::Zeroing { .. });

        if can_refresh {
            let mut state = self.idle().await?;
            for bulb in state.bulbs.values_mut() {
                let _ = bulb.refresh(false).await;
            }
            self.last_status = state
                .bulbs
                .iter()
                .map(|(id, bulb)| {
                    (
                        id.clone(),
                        BulbStatus {
                            pos: bulb.real_extension() / self.max_extension,
                            light_on: bulb.light_on(),
                            zeroing: bulb.zeroing(),
                            disabled: bulb.disable_all(),
                            eeprom_error: bulb.eeprom_error(),
                            max_speed_warn: bulb.max_speed_warn(),
                            drift_detected: bulb.drift_detected(),
                        },
                    )
                })
                .collect();
            self.mode = Mode::Idle { state };
        } else if is_zeroing {
            for status in self.last_status.values_mut() {
                status.zeroing = true;
            }
        }

        Ok(self.last_status.clone())
    }
}

pub struct ConfigureMaxExt {
    pub max_in: f64,
}

impl Message<ConfigureMaxExt> for Driver {
    type Reply = Result<()>;

    async fn handle(
        &mut self,
        msg: ConfigureMaxExt,
        _: &mut Context<Self, Self::Reply>,
    ) -> Result<()> {
        self.max_extension = msg.max_in.clamp(0.0, MAX_EXTENSION);
        let mut state = self.idle().await?;
        for bulb in state.bulbs.values_mut() {
            bulb.write(Command::SetMaxExtension {
                extension: bulb.real_extension(),
                max: self.max_extension,
            })
            .await?;
        }
        self.mode = Mode::Idle { state };
        Ok(())
    }
}

impl Driver {
    pub fn new(
        bus: &ActorRef<i2c::Bus>,
        config: &config::Driver,
        topology: &config::Topology,
    ) -> Self {
        Self {
            mode: Mode::Uninitialized,
            waiters: Vec::new(),
            bus: bus.clone(),
            config: config.clone(),
            topology: topology.clone(),
            last_status: HashMap::new(),
            max_extension: MAX_EXTENSION,
        }
    }

    fn initialize(&self) -> State {
        let tolerance = self.config.extension_tolerance;
        let bulbs = topology::bulbs(&self.topology)
            .into_iter()
            .filter(|slot| !slot.disabled)
            .map(|slot| {
                (
                    slot.id,
                    Bulb::new(self.bus.clone(), slot.address, slot.position, tolerance),
                )
            })
            .collect();

        State {
            bulbs,
            zero_timeout: self.config.zero_timeout(),
            refresh_interval: self.config.refresh_interval(),
        }
    }

    fn take(&mut self) -> Mode {
        replace(&mut self.mode, Mode::Uninitialized)
    }

    async fn idle(&mut self) -> Result<State> {
        let mode = self.take();

        let state = match mode {
            // Already in idle, do nothing.
            Mode::Idle { state } => state,

            // Not yet initialized, set ourselves up.
            Mode::Uninitialized => self.initialize(),

            // Zeroing, wait for it to complete and reap the state.
            Mode::Zeroing { zeroing } => zeroing.await??,

            // Cycling, cancel cycle and reap the state.
            Mode::Cycling { token, cycle } => {
                token.cancel();
                cycle.await??
            }
        };

        Ok(state)
    }

    fn notify_waiters(&mut self, result: Result<()>) {
        if self.waiters.is_empty() {
            return;
        }
        let err_msg = result.err().map(|e| e.to_string());
        for tx in self.waiters.drain(..) {
            tx.send(match &err_msg {
                None => Ok(()),
                Some(msg) => Err(Error::BackgroundTaskFailed(msg.clone())),
            });
        }
    }
}
