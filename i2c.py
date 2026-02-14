import socket
from collections.abc import Mapping
from dataclasses import dataclass

import pigpio

BUS = 1
BASE_ADDRESS = 0x08
NUM_DEVICES = 5

if socket.gethostname() == "pi":
    PI = pigpio.pi()
else:
    PI = pigpio.pi("72.205.124.193", 8888)


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


class I2CDevice:
    def __init__(self, address: int):
        fd = PI.i2c_open(BUS, address)
        if fd < 1:
            raise I2COpenError(f"Could not open I2C device at '{address}'")
        self.fd = fd
        self.address = address

    def write(self, data: bytes):
        try:
            PI.i2c_write_device(self.fd, data)
        except pigpio.error as e:
            raise I2CWriteError(self.address) from e


def enumerate() -> Mapping[Position, I2CDevice]:
    """Return an iteratable over all present I2C devices."""
    return {Position(i * 4, 0): I2CDevice(BASE_ADDRESS + i) for i in range(NUM_DEVICES)}
