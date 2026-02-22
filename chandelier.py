import logging
from collections.abc import Callable, Mapping
from math import sin
import time
from typing import final

import i2c
from i2c import I2CDevice, Position

log = logging.getLogger(__name__)

special_dict = {
    "p": 0,  # position
    "b": 1,  # brightness
    "s": 2,  # save position
    "m": 3,  # max analogWrite value (max speed out of 255)
    "k": 4,  # kp
    "i": 5,  # ki
    "d": 6,  # kd
    "o": 7,  # kp_pos (ramp rate when close)
    "x": 8,  # max speed (in/s divide by 10)
    "z": 9,  # command zero
}


@final
class ExtensionDriftWarning(Warning):
    def __init__(self, *, expected: float, actual: float):
        super().__init__(f"Extension drifting, expected {expected} but got {actual}")
        self.expected = expected
        self.actual = actual


def constrain(val: int, small: int, large: int) -> int:
    return min(max(val, small), large)


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

    def refresh(self, report_drift: bool = False):
        try:
            real_extension, light_on, zeroing = self.read_data()
        except ValueError as e:
            log.warning(e)
            return

        self.real_extension = real_extension
        self.light_on = light_on
        self.zeroing = zeroing

        if (
            abs(self.last_requested_extension - self.real_extension)
            > self.extension_tolerance
        ):
            if report_drift:
                raise ExtensionDriftWarning(
                    expected=self.last_requested_extension, actual=self.real_extension
                )

    def read_data(self) -> tuple[float, bool, bool]:
        data = self.device.read(amount=4)
        if data[2] > 1 or data[3] > 1:
            raise ValueError("Invalid I2C data")
        return data[0] + data[1] / 256, bool(data[2]), bool(data[3])


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
