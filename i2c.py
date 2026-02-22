import time
import logging
import os
from typing import final
from smbus2 import SMBus, i2c_msg
from collections.abc import Mapping
from dataclasses import dataclass
from rich.logging import RichHandler

LEVEL = os.getenv("LOGLEVEL", "INFO").upper()
FORMAT = "%(message)s"
logging.basicConfig(
    level=LEVEL,
    format=FORMAT,
    datefmt="[%X]",
    handlers=[RichHandler()]
)

log = logging.getLogger(__name__)

BUS = 1
BASE_ADDRESS = 0x08
NUM_DEVICES = 5


@dataclass(frozen=True, eq=True)
class Position:
    x: int
    y: int


class I2COpenError(Exception):
    """Raised when the given I2C device could not be opened."""


class I2CWriteError(Exception):
    """Raised when the given I2C device could not be written to."""

    def __init__(self, address: int) -> None:
        super().__init__(
            f"An error occurred while writing to I2C device at address {address}"
        )


@final
class Bus:
    def __init__(self, bus: int, delay: float = 0.020, retries: int = 3):
        self.bus = SMBus(bus)
        self.delay = delay
        self.retries = retries

    def write(self, address: int, data: bytes):
        log.debug(
            "Writing to I2C device at address %d with data %s",
            address,
            [hex(byte) for byte in data]
        )

        w = i2c_msg.write(address, data)
        retries = 0
        while retries < self.retries:
            try:
                self.bus.i2c_rdwr(w)
                time.sleep(self.delay * (retries + 1))
            except OSError:
                if retries > 1:
                    log.warning("I2C write failed after %d retries, retrying...", retries)
                retries += 1
                continue
            else:
                return

        log.error("I2C write failed after %d retries", self.retries)

    def read(self, address: int) -> tuple[float, bool, bool]:
        r = i2c_msg.read(address, 4)
        retries = 0
        while retries < self.retries:
            try:
                self.bus.i2c_rdwr(r)
                time.sleep(self.delay * (retries + 1))
                data = [x for x in bytes(r)]
                if data[2] > 1 or data [3] > 1:
                    log.warning("I2C read bad data")
                    raise OSError
                return (data[0]+data[1]/256, bool(data[2]), bool(data[3]))
            except OSError:
                if retries > 1:
                    log.warning("I2C read failed after %d retries, retrying...", retries)
                retries += 1
                continue
        raise RuntimeError()

@final
class I2CDevice:
    def __init__(self, bus: Bus, address: int):
        self.bus = bus
        self.address = address

    def write(self, data: bytes):
        try:
            self.bus.write(self.address, data)
        except OSError as e:
            raise I2CWriteError(self.address) from e
        
    def read(self):
        try:
            return self.bus.read(self.address)
        except OSError as e:
            raise I2CWriteError(self.address) from e


def get_all() -> Mapping[Position, I2CDevice]:
    """Return a mapping of all present I2C devices and their positions."""
    bus = Bus(BUS)
    return {Position(i * 4, 0): I2CDevice(bus, BASE_ADDRESS + i) for i in range(NUM_DEVICES)}
