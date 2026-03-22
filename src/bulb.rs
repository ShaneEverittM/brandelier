use crate::i2c;
use crate::i2c::Bus;
use bytes::Bytes;
use kameo::actor::ActorRef;
use kameo::error::SendError;
use std::ops::Sub;
use tracing::{debug, info, instrument, warn};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    SendRead(#[from] SendError<i2c::Read, i2c::Error>),

    #[error(transparent)]
    SendWrite(#[from] SendError<i2c::Write, i2c::Error>),

    #[error("Invalid response length, expected 4, got {actual}")]
    InvalidResponseLength { actual: usize },
}

#[derive(Debug)]
#[repr(u8)]
pub enum Command {
    SetExtension { extension: f64 } = 0x00,
    SetBrightness { extension: f64, brightness: f64 } = 0x01,
    SavePosition { extension: f64 } = 0x02,
    SetKpPos { extension: f64, kp_pos: f64 } = 0x07,
    SetMaxSpeed { extension: f64, speed: f64 } = 0x08,
    Zero { extension: f64 } = 0x09,
    SetMaxExtension { extension: f64, max: f64 } = 0x0A,
}

impl Command {
    pub fn opcode(&self) -> u8 {
        // SAFETY: It's somewhere in the docs.
        unsafe { *<*const _>::from(self).cast::<u8>() }
    }

    pub fn requested_extension(&self) -> f64 {
        use Command::*;

        let (SetExtension { extension }
        | SetBrightness { extension, .. }
        | SavePosition { extension }
        | SetKpPos { extension, .. }
        | SetMaxSpeed { extension, .. }
        | Zero { extension }
        | SetMaxExtension { extension, .. }) = *self;

        extension
    }

    pub fn extension(&self) -> u16 {
        let extension = self.requested_extension();
        (extension * 256.0).max(0.0).min(65535.0) as u16
    }

    pub fn argument(&self) -> Option<u8> {
        use Command::*;

        match self {
            SetBrightness { brightness, .. } => Some(*brightness as u8),
            SetKpPos { kp_pos, .. } => Some((*kp_pos * 10.0) as u8),
            SetMaxSpeed { speed, .. } => Some((*speed * 10.0) as u8),
            SetMaxExtension { max, .. } => Some(max.max(0.0).min(115.0) as u8),
            _ => None,
        }
    }

    pub fn encode(&self) -> [u8; 4] {
        let [msb, lsb] = self.extension().to_be_bytes();
        let opcode = self.opcode();
        let argument = self.argument().unwrap_or(0);

        let encoded = [msb, lsb, opcode, argument];

        debug!(?self, ?encoded, "Encoded command");

        encoded
    }
}

#[derive(Debug)]
pub struct Response {
    pub extension: f64,
    pub light: bool,
    pub zeroing: bool,
}

impl Response {
    const LENGTH: usize = 4;

    fn parse(data: &[u8]) -> Result<Self> {
        if data.len() != Self::LENGTH {
            return Err(Error::InvalidResponseLength { actual: data.len() });
        }

        Ok(Self {
            extension: f64::from((data[0] as u16) + (data[1] as u16) / 256),
            light: data[2] != 0,
            zeroing: data[3] != 0,
        })
    }
}

pub struct Bulb {
    bus: ActorRef<Bus>,
    address: u16,
    real_extension: f64,
    light_on: bool,
    zeroing: bool,

    extension_tolerance: f64,
    last_requested_extension: f64,
}

impl Bulb {
    pub fn new(bus: ActorRef<Bus>, address: u16, extension_tolerance: f64) -> Self {
        Self {
            bus,
            address,
            real_extension: 0.0,
            light_on: false,
            zeroing: false,
            extension_tolerance,
            last_requested_extension: 0.0,
        }
    }

    pub async fn write(&mut self, command: Command) -> Result<()> {
        info!(?command, "Writing command");

        self.last_requested_extension = command.requested_extension();
        let data = Bytes::copy_from_slice(&command.encode());
        self.bus
            .ask(i2c::Write {
                address: self.address,
                data,
            })
            .await?;

        Ok(())
    }

    pub async fn read(&mut self) -> Result<Response> {
        let data = self
            .bus
            .ask(i2c::Read {
                address: self.address,
                amount: Response::LENGTH,
            })
            .await?;

        debug!(?data, len=data.len(), "Parsing data");
        let response = Response::parse(&*data)?;
        debug!(?response, "Parsed response");
        Ok(response)
    }

    pub async fn zero(&mut self) -> Result<()> {
        self.write(Command::Zero { extension: 0.0 }).await
    }

    pub async fn refresh(&mut self, report_drift: bool) -> Result<()> {
        let Ok(response) = self.read().await else {
            warn!("Failed to read");
            return Ok(());
        };

        self.real_extension = response.extension;
        self.light_on = response.light;
        self.zeroing = response.zeroing;

        if report_drift {
            if self
                .last_requested_extension
                .sub(self.real_extension)
                .abs()
                .gt(&self.extension_tolerance)
            {
                warn!(
                    expected = self.last_requested_extension,
                    actual = self.real_extension,
                    "Extension drift detected"
                )
            }
        }

        Ok(())
    }

    pub fn zeroing(&self) -> bool {
        self.zeroing
    }
}
