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
    def __init__(
        self, position: Position, device: I2CDevice, scale: int = DEFAULT_SCALE
    ):
        self.device = device
        self.position = position

        if not 0 <= scale <= 16:
            raise ValueError("Invalid scale, must be between 0 and 16")
        self.scale = scale

    def set_position(self, position: int):
        # 16-bit max but with scale extra bits of range, scaled by those extra bits.
        position = constrain(position, 0, ~(~0xFFFF << self.scale)) >> self.scale
        data = position.to_bytes(2, byteorder="big") + bytes(2)
        self.device.write(data)


def main():
    try:
        bulbs = [Bulb(position, device) for position, device in i2c.enumerate().items()]
        while True:
            position = input("Input position: ")  # encoder ticks, a thousand to an inch
            for bulb in bulbs:
                bulb.set_position(int(position))
    except KeyboardInterrupt:
        return
    except Exception as e:
        print(f"An error occurred: {e}")


if __name__ == "__main__":
    main()
