use std::ops::Mul;
use std::ops::Sub;

use bytes::Bytes;
use kameo::actor::ActorRef;
use kameo::error::SendError;
use tracing::debug;
use tracing::info;
use tracing::warn;

use crate::i2c;
use crate::i2c::Bus;

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
    #[expect(unused)]
    SetExtension {
        extension: f64,
    } = 0x00,
    SetBrightness {
        extension: f64,
        brightness: f64,
    } = 0x01,
    #[expect(unused)]
    SavePosition {
        extension: f64,
    } = 0x02,
    #[expect(unused)]
    SetKpPos {
        extension: f64,
        kp_pos: f64,
    } = 0x07,
    #[expect(unused)]
    SetMaxSpeed {
        extension: f64,
        speed: f64,
    } = 0x08,
    Zero {
        extension: f64,
    } = 0x09,
    SetMaxExtension {
        extension: f64,
        max: f64,
    } = 0x0A,
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
        (extension * 256.0).clamp(0.0, 65535.0) as u16
    }

    pub fn argument(&self) -> Option<u8> {
        use Command::*;

        match self {
            SetBrightness { brightness, .. } => Some(*brightness as u8),
            SetKpPos { kp_pos, .. } => Some((*kp_pos * 10.0) as u8),
            SetMaxSpeed { speed, .. } => Some((*speed * 10.0) as u8),
            SetMaxExtension { max, .. } => Some(max.clamp(0.0, 115.0) as u8),
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
    pub speed: f64,
    pub light: bool,
    pub zeroing: bool,
    pub disable_all: bool,
    pub eeprom_error: bool,
}

impl Response {
    const LENGTH: usize = 4;

    fn parse(data: &[u8]) -> Result<Self> {
        if data.len() != Self::LENGTH {
            return Err(Error::InvalidResponseLength { actual: data.len() });
        }

        Ok(Self {
            extension: f64::from((data[0] as u16) + (data[1] as u16) / 256),
            speed: (data[2] as f64) / 32.0,
            light: data[3] & 0b0001 != 0,
            zeroing: data[3] & 0b0010 != 0,
            disable_all: data[3] & 0b0100 != 0,
            eeprom_error: data[3] & 0b1000 != 0,
        })
    }
}

pub struct Bulb {
    bus: ActorRef<Bus>,
    address: u16,
    real_extension: f64,
    real_speed: f64,
    max_speed: f64,
    light_on: bool,
    zeroing: bool,
    disable_all: bool,
    eeprom_error: bool,

    extension_tolerance: f64,
    last_requested_extension: f64,
}

impl Bulb {
    pub fn new(bus: ActorRef<Bus>, address: u16, extension_tolerance: f64) -> Self {
        Self {
            bus,
            address,
            real_extension: 0.0,
            real_speed: 0.0,
            max_speed: 1.0, // this needs to get updated whenever SetMaxExtension is run
            light_on: false,
            zeroing: false,
            disable_all: false,
            eeprom_error: false,
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

        debug!(?data, len = data.len(), "Parsing data");
        let response = Response::parse(&data)?;
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
        self.real_speed = response.speed;
        self.light_on = response.light;
        self.zeroing = response.zeroing;
        self.disable_all = response.disable_all;
        self.eeprom_error = response.eeprom_error;

        if report_drift
            && self // if the real bulb is off by more than a certain distance
                .last_requested_extension
                .sub(self.real_extension)
                .abs()
                .gt(&self.extension_tolerance)
            && self.real_speed.mul(2.0).lt(&self.max_speed)
        // and if running at less than half of max speed
        {
            warn!(
                expected = self.last_requested_extension,
                actual = self.real_extension,
                "Extension drift detected"
            )
        }

        Ok(())
    }

    pub fn zeroing(&self) -> bool {
        self.zeroing
    }
}
