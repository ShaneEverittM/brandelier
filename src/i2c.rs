use bytes::{BufMut, Bytes, BytesMut};
use crc::{CRC_16_XMODEM, Crc};
use i2cdev::core::*;
use i2cdev::linux::{LinuxI2CBus, LinuxI2CError, LinuxI2CMessage};
use kameo::prelude::*;
use retry::delay::Fixed;
use retry::retry;
use std::path::Path;
use std::time::Duration;

const CRC: Crc<u16> = Crc::<u16>::new(&CRC_16_XMODEM);
const TELEMETRY_SIZE: usize = 4;
const RETRIES: usize = 3;
const RETRY_DELAY: Duration = Duration::from_millis(20);

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("I2C Operation failed {0}")]
    I2C(#[from] LinuxI2CError),

    #[error("CRC mismatch, expected {expected} got {actual}")]
    Crc { expected: u16, actual: u16 },

    #[error("Not enough bytes in telemetry read")]
    Eof,

    #[error("IO operation failed after retries")]
    Retry(#[from] Box<retry::Error<Self>>),
}

#[derive(Actor)]
pub struct Bus {
    bus: LinuxI2CBus,
    read_buf: BytesMut,
}

impl Bus {
    pub fn new<P>(path: P) -> Result<Self>
    where
        P: AsRef<Path>,
    {
        let bus = LinuxI2CBus::new(path)?;
        Ok(Self {
            bus,
            read_buf: BytesMut::new(),
        })
    }
}

#[derive(Debug)]
pub struct Read {
    pub address: u16,
    pub amount: usize,
}

impl Bus {
    fn read(bus: &mut LinuxI2CBus, address: u16, buffer: &mut [u8]) -> Result<()> {
        let message = LinuxI2CMessage::read(buffer).with_address(address);
        bus.transfer(&mut [message])?;

        let mut digest = CRC.digest();
        digest.update(&address.to_be_bytes());
        digest.update(&buffer[..TELEMETRY_SIZE]);
        let expected = u16::from_be_bytes(
            <[u8; 2]>::try_from(&buffer[TELEMETRY_SIZE..]).map_err(|_| Error::Eof)?,
        );
        let actual = digest.finalize();
        if expected != actual {
            return Err(Error::Crc { expected, actual });
        }

        Ok(())
    }

    fn write(bus: &mut LinuxI2CBus, address: u16, data: Bytes) -> Result<()> {
        let mut data = BytesMut::from(data);

        let mut digest = CRC.digest();
        digest.update(&address.to_be_bytes());
        digest.update(&data);
        let checksum = digest.finalize();
        data.put_u16(checksum);

        let message = LinuxI2CMessage::write(&*data).with_address(address);
        bus.transfer(&mut [message])?;

        Ok(())
    }
}

impl Message<Read> for Bus {
    type Reply = Result<Bytes>;

    async fn handle(&mut self, msg: Read, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.read_buf.clear();
        self.read_buf.resize(msg.amount, 0);

        retry(Fixed::from(RETRY_DELAY).take(RETRIES), || {
            Bus::read(&mut self.bus, msg.address, &mut *self.read_buf)
        })
        .map_err(Box::new)?;

        Ok(self.read_buf.split().freeze())
    }
}

pub struct Write {
    pub address: u16,
    pub data: Bytes,
}

impl Message<Write> for Bus {
    type Reply = Result<()>;

    async fn handle(&mut self, msg: Write, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        retry(Fixed::from(RETRY_DELAY).take(RETRIES), || {
            Bus::write(&mut self.bus, msg.address, msg.data.clone())
        })
        .map_err(Box::new)?;

        Ok(())
    }
}
