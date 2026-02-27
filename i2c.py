import time
import logging
import os
from typing import final
from smbus2 import SMBus, i2c_msg
from collections.abc import Mapping
from dataclasses import dataclass
from rich.logging import RichHandler

from crc import Crc

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


class I2CError(Exception):
    """Base class for all I2C errors."""
    pass


class I2COpenError(I2CError):
    """Raised when the given I2C device could not be opened."""


class I2CWriteError(I2CError):
    """Raised when the given I2C device could not be written to."""

    def __init__(self, address: int) -> None:
        super().__init__(
            f"An error occurred while writing to I2C device at address {address}"
        )


class I2CReadError(I2CError):
    """Raised when the given I2C device could not be read from."""

    def __init__(self, address: int) -> None:
        super().__init__(
            f"An error occurred while reading from I2C device at address {address}"
        )


class I2CReadRetryError(I2CError):
    """Raised when the given I2C device could not be read from after retrying."""

    def __init__(self, address: int, retries: int) -> None:
        super().__init__(
            f"An error occurred while reading from I2C device at address {address} after {retries} tries"
        )


@final
class Bus:
    def __init__(self, bus: int, delay: float = 0.020, retries: int = 3):
        self.bus = SMBus(bus)
        self.delay = delay
        self.retries = retries

    def write(self, address: int, data: bytes):
        crc = Crc()
        crc.process(address.to_bytes())
        crc.process(data)
        checksum = crc.finalbytes()
        log.debug(
            "Writing to I2C device at address %d with data %s",
            address,
            [hex(byte) for byte in data] + [hex(checksum[0])]
        )

        w = i2c_msg.write(address, data + checksum)
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

    def read(self, address: int, amount: int) -> bytes:
        r = i2c_msg.read(address, amount + 2)
        retries = 0
        while retries < self.retries:
            try:
                self.bus.i2c_rdwr(r)
                data = bytes(r)
                checksum = data[-2:]
                data = data[:-2]
                crc = Crc()
                crc.process(address.to_bytes())
                crc.process(data)
                if crc.finalbytes() != checksum:
                    raise I2CReadError(address)
                return data
            except OSError:
                time.sleep(self.delay * (retries + 1))
                if retries > 1:
                    log.warning("I2C read failed after %d retries, retrying...", retries)
                retries += 1
                continue
            except I2CReadError:
                time.sleep(self.delay * (retries + 1))
                if retries > 1:
                    log.warning("I2C read bad data after %d retries, retrying...", retries)
                retries += 1
                continue

        raise I2CReadRetryError(address, self.retries)


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

    def read(self, amount: int = 4) -> bytes:
        try:
            return self.bus.read(self.address, amount)
        except OSError as e:
            raise I2CReadError(self.address) from e


def get_all() -> Mapping[Position, I2CDevice]:
    """Return a mapping of all present I2C devices and their positions."""
    bus = Bus(BUS)
    return {Position(i * 4, 0): I2CDevice(bus, BASE_ADDRESS + i) for i in range(1)}#NUM_DEVICES)}
