from typing import Literal

from crccheck.crc import Crc8


class Crc(Crc8):
    def process(self, data: bytes) -> None:
        super().process(data)

    def final(self) -> int:
        super().final()

    def finalbytes(self, byteorder: Literal["big", "little"] = 'big') -> bytes:
        super().finalbytes(byteorder)


__all__ = ["Crc"]
