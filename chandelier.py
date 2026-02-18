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
    "o": 7,  # kp_pos (ramp rate when close)
    "x": 8,  # max speed (in/s divide by 10)
    "z": 9,  # command zero
}


def constrain(val: int, small: int, large: int) -> int:
    return min(max(val, small), large)


@final
class Bulb:
    def __init__(self, device: I2CDevice):
        self.device = device
        
    def zero(self):
        data = [0x00, 0x00, 0x09, 0x00]
        self.device.write(bytes(data))

    def set_position(self, position: float):
        # 16-bits: 1 byte for inches, 1 byte for fractions of an inch
        position = constrain(int(position * 256), 0, 0xFFFF)
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
            bulb.set_position(extension)
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
    logging.basicConfig(level=logging.INFO)

    main()
