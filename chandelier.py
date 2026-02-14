from collections.abc import Callable, Mapping
from math import sin
import time
from typing import final

import i2c
from i2c import I2CDevice, Position

special_dict = {
    "p": 0,  # position
    "b": 1,  # brightness
    "s": 2,  # save position
    "m": 3,  # max analogWrite value (max speed out of 255)
    "k": 4,  # kp
    "i": 5,  # ki
    "d": 6,  # kd
    "o": 7,  # kp_pos (ramp rate when close, divide by 10000)
    "x": 8,  # max speed (divide by 10)
    "z": 9,  # command zero
}

DEFAULT_SCALE: int = 5


def constrain(val: int, small: int, large: int) -> int:
    return min(max(val, small), large)


@final
class Bulb:
    def __init__(self, device: I2CDevice, scale: int = DEFAULT_SCALE):
        self.device = device
        if not 0 <= scale <= 16:
            raise ValueError("Invalid scale, must be between 0 and 16")
        self.scale = scale
        
    def zero(self):
        data = [0x00, 0x00, 0x09, 0x00]
        self.device.write(bytes(data))

    def set_position(self, position: int):
        # 16-bit max but with scale extra bits of range, scaled by those extra bits.
        position = constrain(position, 0, ~(~0xFFFF << self.scale)) >> self.scale
        data = position.to_bytes(2, byteorder="big") + bytes(2)
        self.device.write(data)


def driver(
    bulbs: Mapping[Position, Bulb], extensions: Callable[[float, float, float], float]
):
    for bulb in bulbs.values():
        bulb.zero()
    
    # TODO: Query position to know when zeroed.
    time.sleep(10)
    
    while True:
        t = time.monotonic()
        for position, bulb in bulbs.items():
            extension = extensions(position.x, position.y, t)
            bulb.set_position(int(extension))
        time.sleep(0.04)


def main():
    try:
        bulbs = {position: Bulb(device) for position, device in i2c.get_all().items()}
        driver(bulbs, lambda x, _, t: 3000 * sin(0.25 * x + 0.25 * t) + 3100)
    except KeyboardInterrupt:
        return
    except Exception as e:
        print(f"An error occurred: {e}")


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO)

    main()
