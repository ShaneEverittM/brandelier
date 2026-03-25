use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::io;
use std::time::Duration;

use bytes::BufMut;
use bytes::Bytes;
use bytes::BytesMut;
use crc::CRC_16_XMODEM;
use crc::Crc;
use kameo::prelude::*;
use ordered_float::OrderedFloat;
use retry::delay::Fixed;
use retry::retry;
use tokio::time::Instant;
use tokio::time::sleep_until;
use tracing::debug;
use tracing::warn;

use crate::config;

pub trait I2cBus: Send + 'static {
    fn read(&mut self, address: u16, buffer: &mut [u8]) -> io::Result<()>;
    fn write(&mut self, address: u16, data: &[u8]) -> io::Result<()>;
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod linux {
    use std::io;
    use std::path::Path;

    use i2cdev::core::*;
    use i2cdev::linux::LinuxI2CBus;
    use i2cdev::linux::LinuxI2CMessage;

    pub struct LinuxBus(LinuxI2CBus);

    impl LinuxBus {
        pub fn new<P: AsRef<Path>>(path: P) -> io::Result<Self> {
            let bus = LinuxI2CBus::new(path).map_err(io::Error::from)?;
            Ok(Self(bus))
        }
    }

    impl super::I2cBus for LinuxBus {
        fn read(&mut self, address: u16, buffer: &mut [u8]) -> io::Result<()> {
            let message = LinuxI2CMessage::read(buffer).with_address(address);
            self.0.transfer(&mut [message]).map_err(io::Error::from)?;
            Ok(())
        }

        fn write(&mut self, address: u16, data: &[u8]) -> io::Result<()> {
            let message = LinuxI2CMessage::write(data).with_address(address);
            self.0.transfer(&mut [message]).map_err(io::Error::from)?;
            Ok(())
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub use linux::LinuxBus;

#[cfg(not(any(target_os = "linux", target_os = "android")))]
mod mock {
    use std::collections::HashMap;
    use std::io;

    use i2cdev::core::I2CDevice;
    use i2cdev::mock::MockI2CDevice;

    pub struct MockBus {
        devices: HashMap<u16, MockI2CDevice>,
    }

    impl MockBus {
        pub fn new() -> Self {
            Self {
                devices: HashMap::new(),
            }
        }
    }

    impl super::I2cBus for MockBus {
        fn read(&mut self, address: u16, buffer: &mut [u8]) -> io::Result<()> {
            self.devices.entry(address).or_default().read(buffer)
        }

        fn write(&mut self, address: u16, data: &[u8]) -> io::Result<()> {
            self.devices.entry(address).or_default().write(data)
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub use mock::MockBus;

const CRC: Crc<u16> = Crc::<u16>::new(&CRC_16_XMODEM);
const TELEMETRY_SIZE: usize = 4;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("I2C Operation failed {0}")]
    I2C(#[from] io::Error),

    #[error("CRC mismatch, expected {expected} got {actual}")]
    Crc { expected: u16, actual: u16 },

    #[error("Not enough bytes in telemetry read")]
    Eof,

    #[error("IO operation failed after retries")]
    Retry(#[from] Box<retry::Error<Self>>),
}

#[derive(Actor)]
pub struct Bus {
    bus: Box<dyn I2cBus>,
    read_buf: BytesMut,
    last_transfer_to: HashMap<u16, Instant>,
    retries: usize,
    retry_delay: Duration,
    rate_limit: Duration,
}

impl Bus {
    pub fn new(bus: Box<dyn I2cBus>, config: &config::I2c) -> Self {
        Self {
            bus,
            read_buf: BytesMut::new(),
            last_transfer_to: HashMap::new(),
            retries: config.retries,
            retry_delay: config.retry_delay(),
            rate_limit: config.rate_limit(),
        }
    }

    fn read(bus: &mut dyn I2cBus, address: u16, buffer: &mut [u8]) -> Result<()> {
        bus.read(address, buffer)?;

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

    fn write(bus: &mut dyn I2cBus, address: u16, data: Bytes) -> Result<()> {
        let mut data = BytesMut::from(data);

        let mut digest = CRC.digest();
        digest.update(&address.to_be_bytes());
        digest.update(&data);
        let checksum = digest.finalize();
        data.put_u16(checksum);

        bus.write(address, &data)?;

        Ok(())
    }

    async fn rate_limit(&mut self, address: u16) {
        match self.last_transfer_to.entry(address) {
            Entry::Occupied(entry) => {
                sleep_until(*entry.get() + self.rate_limit).await;
            }
            Entry::Vacant(slot) => {
                slot.insert(Instant::now());
            }
        }
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
        self.rate_limit(msg.address).await;

        self.read_buf.clear();
        let size_with_crc = msg.amount + (CRC.algorithm.width / 8) as usize;
        debug!(size = size_with_crc, "Creating read buffer");
        self.read_buf.resize(size_with_crc, 0xff);

        retry(Fixed::from(self.retry_delay).take(self.retries), || {
            Bus::read(&mut *self.bus, msg.address, &mut self.read_buf)
                .inspect_err(|e| warn!(?e, "I2c"))
        })
        .map_err(Box::new)?;

        Ok(self.read_buf.split_to(msg.amount).freeze())
    }
}

pub struct Write {
    pub address: u16,
    pub data: Bytes,
}

impl Message<Write> for Bus {
    type Reply = Result<()>;

    async fn handle(&mut self, msg: Write, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.rate_limit(msg.address).await;

        retry(Fixed::from(self.retry_delay).take(self.retries), || {
            Bus::write(&mut *self.bus, msg.address, msg.data.clone())
                .inspect_err(|e| warn!(?e, "I2c"))
        })
        .map_err(Box::new)?;

        Ok(())
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct Position {
    pub x: OrderedFloat<f64>,
    pub y: OrderedFloat<f64>,
}

pub fn get_addresses(config: &config::I2c) -> impl Iterator<Item = (Position, u16)> {
    let base = config.base_address;
    let spacing = config.device_spacing;
    (0..config.num_devices).map(move |i| {
        (
            Position {
                x: OrderedFloat(i as f64 * spacing),
                y: OrderedFloat(0.0),
            },
            base + i,
        )
    })
}
