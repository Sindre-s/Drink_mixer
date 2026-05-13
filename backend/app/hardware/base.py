from abc import ABC, abstractmethod


class HardwareInterface(ABC):
    @abstractmethod
    async def initialize(self) -> None:
        pass

    @abstractmethod
    async def pump_on(self, pump_number: int) -> None:
        pass

    @abstractmethod
    async def pump_off(self, pump_number: int) -> None:
        pass

    @abstractmethod
    async def all_off(self) -> None:
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        pass
