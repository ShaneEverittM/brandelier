import traceback
import logging
import time
from abc import ABC
from dataclasses import dataclass
from enum import IntEnum
from collections.abc import Callable, Mapping
from math import sin
from typing import final, ClassVar
from typing_extensions import Self, override

import i2c
from i2c import I2CDevice, Position, I2CReadRetryError

log = logging.getLogger(__name__)


class OpCode(IntEnum):
    SET_EXTENSION = 0
    SET_BRIGHTNESS = 1
    SAVE_POSITION = 2
    SET_MAX_PWM = 3 # un-implemented
    SET_KP = 4 # not needed yet
    SET_KI = 5 # not needed yet
    SET_KD = 6 # not needed yet, probably ever
    SET_KP_POS = 7 # how quickly the bulb chases its new position
    SET_MAX_SPEED = 8 # inches per second
    ZERO = 9
    SET_MAX_EXTENSION = 10 # inches


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
        self.extension: float = extension

    def opcode(self) -> OpCode:
        return OpCode.SET_EXTENSION

    def argument(self) -> int:
        return 0x00

    @final
    def encode(self) -> bytes:
        [lsb, msb] = constrain(int(self.extension * 256), 0, 0xFFFF).to_bytes(2, byteorder="big")
        opcode = self.opcode()
        argument = self.argument()
        data = bytes([lsb, msb, opcode, argument])
        return data


@final
class SetExtension(Command):
    pass


@final
class SetBrightness(Command):
    """Sets the brightness of the bulb. Individual value changes below 20 are noticable."""
    def __init__(self, extension: float, value: int):
        super().__init__(extension)
        self._value = value

    @override
    def opcode(self) -> OpCode:
        return OpCode.SET_BRIGHTNESS

    @override
    def argument(self) -> int:
        return constrain(self._value, 0, 255)


@final
class Zero(Command):
    def __init__(self):
        super().__init__(0)

    @override
    def opcode(self) -> OpCode:
        return OpCode.ZERO

@final
class Save(Command):
    """Saves the bulb's position internally so each microcontroller knows where it left off. Primarily used before shutdown."""
    def __init__(self, extension: float):
        super().__init__(extension)

    @override
    def opcode(self) -> OpCode:
        return OpCode.SAVE_POSITION

@final
class SetMaxExtension(Command):
    """Max extension in inches. Whole number only."""
    def __init__(self, extension: float, max_extension: int):
        super().__init__(extension)
        self._max_extension = max_extension

    @override
    def opcode(self) -> OpCode:
        return OpCode.SET_MAX_EXTENSION

    @override
    def argument(self) -> int:
        return constrain(self._max_extension, 0, 115) # 115 is maximum length of current design

@final
class SetMaxSpeed(Command):
    """Max bulb speed in inches per second. Rounds to one decimal point."""
    def __init__(self, extension: float, max_speed: float):
        super().__init__(extension)
        self._max_speed = int(max_speed * 10)

    @override
    def opcode(self) -> OpCode:
        return OpCode.SET_MAX_SPEED

    @override
    def argument(self) -> int:
        return constrain(self._max_speed, 0, 255)

@final
class SetKpPos(Command):
    """Determines how quickly the bulb chases its commanded position. Rounds to one decimal point. Default value is 3.0"""
    def __init__(self, extension: float, kp_pos: float):
        super().__init__(extension)
        self._kp_pos = int(kp_pos * 10)

    @override
    def opcode(self) -> OpCode:
        return OpCode.SET_KP_POS

    @override
    def argument(self) -> int:
        return constrain(self._kp_pos, 0, 255)

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

    def zero(self):
        self.write(Zero())

    def write(self, command: Command) -> None:
        self.last_requested_extension = command.extension
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
    bulbs: Mapping[Position, Bulb], extensions: Callable[[float, float, float], float], brightnesses: Callable[[float, float, float], int]
):
    for bulb in bulbs.values():
        bulb.write(SetMaxExtension(0, 65)) #65 inches is currently the length I have available for testing
        bulb.zero()
        bulb.refresh()

    timeout = 60.0
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
            brightness = brightnesses(position.x, position.y, t)
            bulb.write(SetBrightness(extension, brightness))

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
        driver(bulbs, lambda x, _, t: 3 * sin(0.25 * x + 0.25 * t) + 4, lambda x, _, t: int(16 * sin(0.25 * x + 0.25 * t) + 20))
    except KeyboardInterrupt:
        return
    except Exception as e:
        traceback.print_exc()
        print(f"An error occurred: {e}")


if __name__ == "__main__":
    import logging

    logging.basicConfig(level=logging.DEBUG)

    main()
