use std::path::Path;

use bytes::{BufMut, Bytes, BytesMut};
use crc::{CRC_16_XMODEM, Crc};
use i2cdev::core::*;
use i2cdev::linux::{LinuxI2CBus, LinuxI2CError, LinuxI2CMessage};
use kameo::prelude::*;

const CRC: Crc<u16> = Crc::<u16>::new(&CRC_16_XMODEM);
const TELEMETRY_SIZE: usize = 4;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("I2C Operation failed {0}")]
    I2C(#[from] LinuxI2CError),

    #[error("CRC mismatch, expected {expected} got {actual}")]
    Crc { expected: u16, actual: u16 },

    #[error("Not enough bytes in telemetry read")]
    Eof,
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

impl Message<Read> for Bus {
    type Reply = Result<Bytes>;

    async fn handle(&mut self, msg: Read, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.read_buf.resize(msg.amount, 0);

        let message = LinuxI2CMessage::read(&mut *self.read_buf).with_address(msg.address);
        self.bus.transfer(&mut [message])?;
        let data = self.read_buf.split().freeze();

        let mut digest = CRC.digest();
        digest.update(&msg.address.to_be_bytes());
        digest.update(&data[..TELEMETRY_SIZE]);
        let expected = u16::from_be_bytes(
            <[u8; 2]>::try_from(&data[TELEMETRY_SIZE..]).map_err(|_| Error::Eof)?,
        );
        let actual = digest.finalize();
        if expected != actual {
            return Err(Error::Crc { expected, actual });
        }

        Ok(data)
    }
}

pub struct Write {
    address: u16,
    data: Bytes,
}

impl Message<Write> for Bus {
    type Reply = Result<()>;

    async fn handle(&mut self, msg: Write, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        let mut data = BytesMut::from(msg.data);

        let mut digest = CRC.digest();
        digest.update(&msg.address.to_be_bytes());
        digest.update(&data);
        let checksum = digest.finalize();
        data.put_u16(checksum);

        let message = LinuxI2CMessage::write(&*data).with_address(msg.address);
        self.bus.transfer(&mut [message])?;

        Ok(())
    }
}
