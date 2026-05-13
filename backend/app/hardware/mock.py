from .base import HardwareInterface


class MockHardware(HardwareInterface):
    """Test/simulation implementation that does not require GPIO hardware."""

    def __init__(self):
        self.active_pumps: set[int] = set()

    async def initialize(self) -> None:
        await self.all_off()

    async def pump_on(self, pump_number: int) -> None:
        self.active_pumps.add(pump_number)

    async def pump_off(self, pump_number: int) -> None:
        self.active_pumps.discard(pump_number)

    async def all_off(self) -> None:
        self.active_pumps.clear()

    async def shutdown(self) -> None:
        await self.all_off()
