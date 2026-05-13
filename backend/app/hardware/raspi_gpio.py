from .base import HardwareInterface

try:
    from gpiozero import OutputDevice
except ImportError:  # pragma: no cover
    OutputDevice = None


class RaspberryPiGPIOHardware(HardwareInterface):
    """Real GPIO-backed hardware adapter for relay-controlled pumps."""

    def __init__(self, pumps: list[dict]):
        if OutputDevice is None:
            raise RuntimeError("gpiozero is not installed. Use simulation mode or install gpiozero.")

        self._devices: dict[int, OutputDevice] = {}
        for pump in pumps:
            pump_number = int(pump["pump"])
            gpio_pin = int(pump["gpio_pin"])
            # initial_value=False keeps relays OFF at startup.
            self._devices[pump_number] = OutputDevice(
                gpio_pin,
                active_high=True,
                initial_value=False,
            )

    async def initialize(self) -> None:
        # Defensive startup safety: explicitly force every relay to OFF.
        await self.all_off()

    async def pump_on(self, pump_number: int) -> None:
        self._get_device(pump_number).on()

    async def pump_off(self, pump_number: int) -> None:
        self._get_device(pump_number).off()

    async def all_off(self) -> None:
        for device in self._devices.values():
            device.off()

    async def shutdown(self) -> None:
        await self.all_off()
        for device in self._devices.values():
            device.close()

    def _get_device(self, pump_number: int) -> OutputDevice:
        try:
            return self._devices[pump_number]
        except KeyError as exc:
            raise ValueError(f"Pump {pump_number} is not configured in pumps.json") from exc
