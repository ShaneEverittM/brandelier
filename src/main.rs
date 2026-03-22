mod i2c;

use i2c::Bus;
use kameo::prelude::*;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    I2C(#[from] i2c::Error),

    #[error(transparent)]
    Send(#[from] SendError<i2c::Read, i2c::Error>),
}

#[tokio::main]
async fn main() -> Result<()> {
    let bus = Bus::spawn_in_thread(Bus::new("/dev/i2c-1")?);
    let data = bus
        .ask(i2c::Read {
            address: 0x08,
            amount: 6,
        })
        .await?;
    println!("Read {} bytes, got: ", data.len());

    Ok(())
}
