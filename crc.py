from typing_extensions import override, Self

from crccheck.crc import Crc16  # pyright: ignore[reportMissingTypeStubs]


class Crc(Crc16):
    @override
    def process(self, data: bytes) -> Self:
        return super().process(data)  # pyright: ignore[reportUnknownMemberType]

    @override
    def final(self) -> int:
        return super().final()  # pyright: ignore[reportUnknownVariableType]

    @override
    def finalbytes(self, byteorder: str = "big") -> bytes:
        return bytes(super().finalbytes(byteorder))  # pyright: ignore[reportUnknownArgumentType]


__all__ = ["Crc"]
