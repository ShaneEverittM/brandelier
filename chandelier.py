from abc import ABC
from dataclasses import dataclass
from enum import IntEnum
import logging
from collections.abc import Callable, Mapping
from math import sin
import time
from typing import final, ClassVar
from typing_extensions import Self, override

import i2c
from i2c import I2CDevice, Position, I2CReadRetryError

log = logging.getLogger(__name__)


class OpCode(IntEnum):
    SET_EXTENSION = 0
    SET_BRIGHTNESS = 1
    SAVE_POSITION = 2
    SET_MAX_VALUE = 3
    SET_KP = 4
    SET_KI = 5
    SET_KD = 6
    SET_KP_POS = 7
    SET_MAX_SPEED = 8
    ZERO = 9
    SET_MAX_EXTENSION = 10


@final
class ExtensionDriftWarning(Warning):
    def __init__(self, *, expected: float, actual: float):
        super().__init__(f"Extension drifting, expected {expected} but got {actual}")
        self.expected = expected
        self.actual = actual


def constrain(val: int, small: int, large: int) -> int:
    return min(max(val, small), large)


class Command(ABC):
    def __init__(self, extension: float):
        self._extension: int = constrain(int(extension * 256), 0, 0xFFFF)

    def opcode(self) -> OpCode:
        return OpCode.SET_EXTENSION

    def argument(self) -> int:
        return 0x00

    @final
    def encode(self) -> bytes:
        [lsb, msb] = self._extension.to_bytes(2, byteorder="big")
        opcode = self.opcode()
        argument = self.argument()
        data = bytes([lsb, msb, opcode, argument])
        return data


@final
class SetExtension(Command):
    pass


@final
class SetBrightness(Command):
    def __init__(self, extension: float, value: int):
        super().__init__(extension)
        self._value = value

    @override
    def opcode(self) -> OpCode:
        return OpCode.SET_BRIGHTNESS

    @override
    def argument(self) -> int:
        return self._value


@dataclass
class Response:
    extension: float
    light: bool
    zeroing: bool

    LENGTH: ClassVar[int] = 4

    @classmethod
    def parse(cls, data: bytes) -> Self:
        return cls(data[0] + data[1] / 256, bool(data[2]), bool(data[3]))


@final
class Bulb:
    def __init__(self, device: I2CDevice, extension_tolerance: float = 1.0):
        self.device = device
        self.real_extension: float = 0.0
        self.light_on: bool = False
        self.zeroing: bool = False

        self.extension_tolerance = extension_tolerance
        self.last_requested_extension: float = 0.0
        self.lagging_warning: bool = False

    def zero(self):
        # set position to zero and command zeroing routine
        data = [0x00, 0x00, 0x09, 0x00]
        self.device.write(bytes(data))

    def set_extension(self, extension: float):
        # 16-bits: 1 byte for inches, 1 byte for fractions of an inch
        self.last_requested_extension = extension
        extension = constrain(int(extension * 256), 0, 0xFFFF)
        data = extension.to_bytes(2, byteorder="big") + bytes(2)
        self.device.write(data)

    def write(self, command: Command) -> None:
        data = command.encode()
        self.device.write(data)

    def read(self) -> Response:
        data = self.device.read(amount=Response.LENGTH)
        return Response.parse(data)

    def transfer(self, command: Command) -> Response:
        self.write(command)
        return self.read()

    def refresh(self, report_drift: bool = False):
        try:
            response = self.read()
        except I2CReadRetryError as e:
            log.warning(e)
            return

        self.real_extension = response.extension
        self.light_on = response.light
        self.zeroing = response.zeroing

        if (
                abs(self.last_requested_extension - self.real_extension)
                > self.extension_tolerance
        ):
            if report_drift:
                raise ExtensionDriftWarning(
                    expected=self.last_requested_extension, actual=self.real_extension
                )


def driver(
        bulbs: Mapping[Position, Bulb], extensions: Callable[[float, float, float], float]
):
    for bulb in bulbs.values():
        bulb.zero()
        bulb.refresh()

    timeout = 10.0
    elapsed = 0.0
    while any(bulb.zeroing for bulb in bulbs.values()):
        for bulb in bulbs.values():
            bulb.refresh()
        time.sleep(0.1)
        elapsed += 0.1
        if elapsed > timeout:
            raise TimeoutError("Timed out zeroing")

    settle_time = 5.0
    start = time.monotonic()
    last_check = 0
    while True:
        t = time.monotonic()
        for position, bulb in bulbs.items():
            extension = extensions(position.x, position.y, t)
            bulb.set_extension(extension)

        if t - last_check > 1:
            for position, bulb in bulbs.items():
                try:
                    settled = t - start > settle_time
                    bulb.refresh(report_drift=settled)
                except ExtensionDriftWarning as w:
                    print(f"Extension drift for bulb at position {position}:")
                    print(f"    commanded extension: {w.expected}")
                    print(f"    real extension: {w.actual}")
                    print(f"    lagging by {w.actual - w.expected}")
            last_check = t

        time.sleep(0.04)


def main():
    try:
        bulbs = {position: Bulb(device) for position, device in i2c.get_all().items()}
        driver(bulbs, lambda x, _, t: 3 * sin(0.25 * x + 0.25 * t) + 3.1)
    except KeyboardInterrupt:
        return
    except Exception as e:
        print(f"An error occurred: {e}")


if __name__ == "__main__":
    import logging

    logging.basicConfig(level=logging.DEBUG)

    main()
