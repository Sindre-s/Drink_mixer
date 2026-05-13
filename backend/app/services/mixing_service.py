import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from ..hardware.base import HardwareInterface
from .progress_hub import ProgressHub


@dataclass
class MixStatus:
    state: str = "idle"
    run_id: str | None = None
    drink_id: str | None = None
    drink_name: str | None = None
    current_ingredient: str | None = None
    progress: int = 0
    error: str | None = None


class PumpController:
    """
    Coordinates recipe execution:
    - validates pump/calibration values
    - computes run time from ml and ml_per_second
    - streams progress updates
    - supports emergency stop
    """

    def __init__(
        self,
        hardware: HardwareInterface,
        progress_hub: ProgressHub,
        pumps: list[dict],
        mode: str,
        logger: logging.Logger,
    ):
        self.hardware = hardware
        self.progress_hub = progress_hub
        self.status = MixStatus()
        self.mode = mode
        self.logger = logger
        self._mix_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._stop_requested = asyncio.Event()
        self._ml_per_second_by_pump = self._build_calibration_map(pumps)
        self._started_at = datetime.now(timezone.utc)
        self._last_completed_drink: dict | None = None
        self._drinks_made_by_day: dict[str, int] = {}

    @staticmethod
    def _build_calibration_map(pumps: list[dict]) -> dict[int, float]:
        calibration: dict[int, float] = {}
        for pump in pumps:
            pump_number = int(pump["pump"])
            ml_per_second = float(pump["ml_per_second"])
            if ml_per_second <= 0:
                raise ValueError(f"Invalid calibration for pump {pump_number}: ml_per_second must be > 0")
            calibration[pump_number] = ml_per_second
        return calibration

    async def initialize(self) -> None:
        await self.hardware.initialize()

    async def start_mix(self, drink: dict) -> str:
        async with self._lock:
            if self._mix_task and not self._mix_task.done():
                raise RuntimeError("Mixer is busy")

            run_id = str(uuid.uuid4())
            self._stop_requested.clear()
            self.status = MixStatus(
                state="mixing",
                run_id=run_id,
                drink_id=drink["id"],
                drink_name=drink["name"],
                progress=0,
            )
            self.logger.info(
                "drink_started run_id=%s drink_id=%s drink_name=%s",
                run_id,
                drink["id"],
                drink["name"],
            )
            self._mix_task = asyncio.create_task(self._run_recipe(drink))
            return run_id

    async def emergency_stop(self) -> None:
        self._stop_requested.set()
        await self.hardware.all_off()
        if self._mix_task and not self._mix_task.done():
            self._mix_task.cancel()

        self.status.state = "stopped"
        self.status.current_ingredient = None
        self.status.error = "Emergency stop activated"
        self.logger.warning(
            "emergency_stop run_id=%s drink_id=%s drink_name=%s progress=%s",
            self.status.run_id,
            self.status.drink_id,
            self.status.drink_name,
            self.status.progress,
        )
        await self.progress_hub.publish(
            {
                "event": "stopped",
                "run_id": self.status.run_id,
                "progress": self.status.progress,
                "message": "Emergency stop activated",
            }
        )

    def get_status(self) -> dict:
        today_key = datetime.now(timezone.utc).date().isoformat()
        uptime_seconds = int((datetime.now(timezone.utc) - self._started_at).total_seconds())
        return {
            "state": self.status.state,
            "run_id": self.status.run_id,
            "drink_id": self.status.drink_id,
            "drink_name": self.status.drink_name,  # Backward-compatible key
            "current_drink": self.status.drink_name,
            "current_ingredient": self.status.current_ingredient,
            "progress": self.status.progress,
            "error": self.status.error,
            "backend_started_at": self._started_at.isoformat(),
            "backend_uptime_seconds": uptime_seconds,
            "last_completed_drink": self._last_completed_drink,
            "drinks_made_today": self._drinks_made_by_day.get(today_key, 0),
            "mode": "real" if self.mode == "gpio" else "mock",
        }

    async def _run_recipe(self, drink: dict) -> None:
        ingredients = drink.get("ingredients", [])
        total_steps = len(ingredients)
        if total_steps == 0:
            self.status.state = "error"
            self.status.error = "Recipe has no ingredients"
            self.logger.error(
                "mix_error run_id=%s drink_id=%s drink_name=%s error=%s",
                self.status.run_id,
                self.status.drink_id,
                self.status.drink_name,
                self.status.error,
            )
            await self.hardware.all_off()
            await self.progress_hub.publish({"event": "error", "message": self.status.error})
            return

        await self.progress_hub.publish(
            {
                "event": "started",
                "run_id": self.status.run_id,
                "drink_id": drink["id"],
                "drink_name": drink["name"],
                "progress": 0,
            }
        )

        try:
            if total_steps <= 5:
                await self._run_parallel_recipe(drink, ingredients)
            else:
                await self._run_sequential_recipe(drink, ingredients)

            self.status.state = "completed"
            self.status.current_ingredient = None
            self.status.progress = 100
            completed_at = datetime.now(timezone.utc)
            today_key = completed_at.date().isoformat()
            self._drinks_made_by_day[today_key] = self._drinks_made_by_day.get(today_key, 0) + 1
            self._last_completed_drink = {
                "run_id": self.status.run_id,
                "drink_id": drink["id"],
                "drink_name": drink["name"],
                "completed_at": completed_at.isoformat(),
            }
            self.logger.info(
                "drink_completed run_id=%s drink_id=%s drink_name=%s",
                self.status.run_id,
                drink["id"],
                drink["name"],
            )
            await self.progress_hub.publish(
                {"event": "completed", "run_id": self.status.run_id, "progress": 100}
            )
        except asyncio.CancelledError:
            # Stop endpoint can cancel active mixes. Relays are already forced off.
            await self.hardware.all_off()
            return
        except Exception as exc:
            self.status.state = "error"
            self.status.error = str(exc)
            self.status.current_ingredient = None
            self.logger.exception(
                "mix_error run_id=%s drink_id=%s drink_name=%s error=%s",
                self.status.run_id,
                self.status.drink_id,
                self.status.drink_name,
                exc,
            )
            await self.hardware.all_off()
            await self.progress_hub.publish(
                {
                    "event": "error",
                    "run_id": self.status.run_id,
                    "message": str(exc),
                    "progress": self.status.progress,
                }
            )
        finally:
            if self.status.state in {"completed", "error"}:
                await self.hardware.all_off()

    async def _run_sequential_recipe(self, drink: dict, ingredients: list[dict]) -> None:
        total_steps = len(ingredients)
        step_durations: list[float] = []
        for ingredient in ingredients:
            pump_number = int(ingredient["pump"])
            amount_ml = float(ingredient["ml"])
            if pump_number not in self._ml_per_second_by_pump:
                raise ValueError(f"Pump {pump_number} not configured")
            step_durations.append(amount_ml / self._ml_per_second_by_pump[pump_number])

        total_duration = sum(step_durations)
        elapsed_before_step = 0.0

        for step_idx, ingredient in enumerate(ingredients, start=1):
            if self._stop_requested.is_set():
                return

            pump_number = int(ingredient["pump"])
            ingredient_name = str(ingredient.get("name") or f"Pump {pump_number}")
            amount_ml = float(ingredient["ml"])
            if amount_ml <= 0:
                raise ValueError(f"Invalid amount {amount_ml}ml for ingredient {ingredient_name}")
            if pump_number not in self._ml_per_second_by_pump:
                raise ValueError(f"Pump {pump_number} not configured")

            ml_per_second = self._ml_per_second_by_pump[pump_number]
            run_seconds = amount_ml / ml_per_second
            remaining_seconds = max(0.0, total_duration - elapsed_before_step)

            self.status.current_ingredient = ingredient_name
            self.status.progress = int(((step_idx - 1) / total_steps) * 100)
            await self.progress_hub.publish(
                {
                    "event": "pouring",
                    "run_id": self.status.run_id,
                    "step": step_idx,
                    "total_steps": total_steps,
                    "ingredient_name": ingredient_name,
                    "pump": pump_number,
                    "amount_ml": amount_ml,
                    "run_seconds": round(run_seconds, 2),
                    "remaining_seconds": round(remaining_seconds, 2),
                    "progress": self.status.progress,
                }
            )

            await self.hardware.pump_on(pump_number)
            try:
                await asyncio.sleep(run_seconds)
            finally:
                await self.hardware.pump_off(pump_number)

            self.status.progress = int((step_idx / total_steps) * 100)
            elapsed_before_step += run_seconds
            await self.progress_hub.publish(
                {
                    "event": "step_done",
                    "run_id": self.status.run_id,
                    "step": step_idx,
                    "total_steps": total_steps,
                    "remaining_seconds": round(max(0.0, total_duration - elapsed_before_step), 2),
                    "progress": self.status.progress,
                }
            )

    async def _run_parallel_recipe(self, drink: dict, ingredients: list[dict]) -> None:
        pump_plan: dict[int, dict] = {}
        for ingredient in ingredients:
            pump_number = int(ingredient["pump"])
            ingredient_name = str(ingredient.get("name") or f"Pump {pump_number}")
            amount_ml = float(ingredient["ml"])
            if amount_ml <= 0:
                raise ValueError(f"Invalid amount {amount_ml}ml for ingredient {ingredient_name}")
            if pump_number not in self._ml_per_second_by_pump:
                raise ValueError(f"Pump {pump_number} not configured")

            entry = pump_plan.setdefault(
                pump_number,
                {"names": set(), "amount_ml": 0.0},
            )
            entry["names"].add(ingredient_name)
            entry["amount_ml"] += amount_ml

        if len(pump_plan) > 5:
            # More than 5 concurrent pumps is forced back to sequential behavior.
            await self._run_sequential_recipe(drink, ingredients)
            return

        run_items: list[dict] = []
        for pump_number, entry in pump_plan.items():
            ml_per_second = self._ml_per_second_by_pump[pump_number]
            run_seconds = float(entry["amount_ml"]) / ml_per_second
            run_items.append(
                {
                    "pump": pump_number,
                    "ingredient_name": " + ".join(sorted(entry["names"])),
                    "amount_ml": float(entry["amount_ml"]),
                    "run_seconds": run_seconds,
                }
            )

        max_run_seconds = max(item["run_seconds"] for item in run_items)
        self.status.current_ingredient = "Multi-pour"
        self.status.progress = 0

        async def run_single_pump(pump_number: int, run_seconds: float) -> None:
            await self.hardware.pump_on(pump_number)
            try:
                await asyncio.sleep(run_seconds)
            finally:
                await self.hardware.pump_off(pump_number)

        for idx, item in enumerate(run_items, start=1):
            await self.progress_hub.publish(
                {
                    "event": "pouring",
                    "run_id": self.status.run_id,
                    "step": idx,
                    "total_steps": len(run_items),
                    "ingredient_name": item["ingredient_name"],
                    "pump": item["pump"],
                    "amount_ml": round(item["amount_ml"], 2),
                    "run_seconds": round(item["run_seconds"], 2),
                    "progress": self.status.progress,
                }
            )

        tasks = [
            asyncio.create_task(run_single_pump(item["pump"], item["run_seconds"]))
            for item in run_items
        ]

        start_time = asyncio.get_running_loop().time()
        while True:
            if self._stop_requested.is_set():
                return

            done_count = sum(1 for task in tasks if task.done())
            elapsed = asyncio.get_running_loop().time() - start_time
            remaining_seconds = max(0.0, max_run_seconds - elapsed)
            time_progress = min(99, int((elapsed / max_run_seconds) * 100)) if max_run_seconds > 0 else 99
            completion_progress = int((done_count / len(tasks)) * 100)
            self.status.progress = max(self.status.progress, min(99, max(time_progress, completion_progress)))
            await self.progress_hub.publish(
                {
                    "event": "step_done",
                    "run_id": self.status.run_id,
                    "step": done_count,
                    "total_steps": len(tasks),
                    "remaining_seconds": round(remaining_seconds, 2),
                    "progress": self.status.progress,
                }
            )

            if done_count == len(tasks):
                break
            await asyncio.sleep(0.2)

        await asyncio.gather(*tasks)

    async def shutdown(self) -> None:
        await self.hardware.all_off()
        if self._mix_task and not self._mix_task.done():
            self._mix_task.cancel()
        await self.hardware.shutdown()
