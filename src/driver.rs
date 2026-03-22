use crate::bulb;
use crate::bulb::{Bulb, Command};
use crate::i2c::Position;
use kameo::Actor;
use std::collections::HashMap;
use std::convert::identity;
use std::time::Duration;
use tokio::time::{Instant, timeout};
use tracing::info;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("Error interacting with bulb: '{0}'")]
    Bulb(#[from] bulb::Error),

    #[error("Timed out zeroing")]
    ZeroTimeout,
}

#[derive(Actor)]
pub struct Driver {
    bulbs: HashMap<Position, Bulb>,
    extensions: fn(f64, f64, f64) -> f64,
    brightnesses: fn(f64, f64, f64) -> f64,
}

impl Driver {
    pub fn new(
        bulbs: HashMap<Position, Bulb>,
        extensions: fn(f64, f64, f64) -> f64,
        brightnesses: fn(f64, f64, f64) -> f64,
    ) -> Self {
        Self {
            bulbs,
            extensions,
            brightnesses,
        }
    }

    pub async fn zero(&mut self) -> Result<()> {
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
            while self.bulbs.values().map(Bulb::zeroing).any(identity) {
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
            Ok(Err(e)) => return Err(e.into()),
        }

        Ok(())
    }

    pub async fn cycle(&mut self) -> Result<()> {
        let settle_time = Duration::from_secs(5);
        let start_t = Instant::now();
        let mut last_check = None;

        loop {
            let now = Instant::now();
            let t = (now - start_t).as_secs_f64();

            for (position, bulb) in &mut self.bulbs {
                let extension = (self.extensions)(*position.x, *position.y, t);
                let brightness = (self.brightnesses)(*position.x, *position.y, t);
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
    }
}
