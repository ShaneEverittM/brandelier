use std::collections::HashMap;
use std::mem::replace;
use std::time::Duration;

use kameo::error::Infallible;
use kameo::mailbox::Signal;
use kameo::prelude::*;
use tokio::select;
use tokio::task;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::error;
use tracing::info;

use crate::bulb;
use crate::bulb::Bulb;
use crate::bulb::Command;
use crate::i2c;
use crate::i2c::Position;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("Error interacting with bulb: '{0}'")]
    Bulb(#[from] bulb::Error),

    #[error("Timed out zeroing")]
    ZeroTimeout,

    #[error("Background task panicked")]
    TaskJoin(#[from] task::JoinError),

    #[error(transparent)]
    I2C(#[from] i2c::Error),
}

pub struct State {
    bulbs: HashMap<Position, Bulb>,
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

                for (position, bulb) in &mut self.bulbs {
                    let extension = (3.0 * (0.25 * *position.x + 0.25 * t).sin()) + 4.0;
                    let brightness = (16.0 * (0.25 * *position.x + 0.25 * t).sin()) + 20.0;
                    bulb.write(Command::SetBrightness {
                        extension,
                        brightness,
                    })
                    .await?;
                }

                if let Some(last) = last_check
                    && now - last > Duration::from_secs(1)
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
        match timeout(Duration::from_secs(60), zero).await {
            Ok(Ok(())) => {}
            Err(_) => return Err(Error::ZeroTimeout),
            Ok(Err(e)) => return Err(e),
        }

        Ok(self)
    }
}

pub enum Driver {
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
            match self {
                Driver::Uninitialized | Driver::Idle { .. } => return mailbox_rx.recv().await,
                Driver::Zeroing { zeroing: task } | Driver::Cycling { cycle: task, .. } => {
                    select! {
                        signal = mailbox_rx.recv() => return signal,

                        state = task => {
                            match state {
                                Ok(Ok(state)) => {
                                    *self = Self::Idle { state };
                                }
                                Err(error) => {
                                    error!(?error, "Background task panicked");
                                }
                                Ok(Err(error)) => {
                                    error!(?error, "Background operation failed, reinitializing")
                                }
                            }
                            continue
                        }
                    }
                }
            }
        }
    }
}

// - Load/save configurations
//  - There may be curated configs that are "out-of-the-box"
//  - Configurations (at least for now) encode static position
//    - May allow just "rotation" of that static position
// - Individual bulb control
//   - Sliders for position and brightness
// - Zeroing
//   - Auto-zero in some conditions
//   - Per-bulb zeroing on demand

pub struct Zero;

impl Message<Zero> for Driver {
    type Reply = Result<()>;

    async fn handle(&mut self, _: Zero, _: &mut Context<Self, Self::Reply>) -> Result<()> {
        let state = self.idle().await?;
        let zeroing = task::spawn(state.zero());
        *self = Self::Zeroing { zeroing };

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
        *self = Self::Cycling { token, cycle };

        Ok(())
    }
}

pub struct Stop;

impl Message<Stop> for Driver {
    type Reply = Result<()>;

    async fn handle(&mut self, _: Stop, _: &mut Context<Self, Self::Reply>) -> Result<()> {
        let state = self.idle().await?;
        *self = Self::Idle { state };
        Ok(())
    }
}

impl Driver {
    pub fn new() -> Self {
        Self::Uninitialized
    }

    fn initialize() -> Result<State> {
        let bus = i2c::get_bus()?;
        let bulbs = i2c::get_addresses()?
            .map(|(pos, addr)| (pos, Bulb::new(bus.clone(), addr, 1.0)))
            .collect();

        Ok(State { bulbs })
    }

    fn take(&mut self) -> Self {
        replace(self, Driver::Uninitialized)
    }

    async fn idle(&mut self) -> Result<State> {
        // Make self uninitialized, as we try to idle.
        let driver = self.take();

        let state = match driver {
            // Already in idle, do nothing.
            Driver::Idle { state } => state,

            // Not yet initialized, set ourselves up.
            Driver::Uninitialized => Self::initialize()?,

            // Zeroing, wait for it to complete and reap the state.
            Driver::Zeroing { zeroing } => zeroing.await??,

            // Cycling, cancel cycle and reap the state.
            Driver::Cycling { token, cycle } => {
                token.cancel();
                cycle.await??
            }
        };

        Ok(state)
    }
}
