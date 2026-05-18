import json
from pathlib import Path
from typing import Any


class ConfigStore:
    def __init__(self, config_dir: Path | None = None):
        root = Path(__file__).resolve().parents[3]
        self.config_dir = config_dir or (root / "config")
        self.drinks = self._load_json("drinks.json")
        self.pumps = self._load_json("pumps.json")
        self.calibration = self._load_optional_json("calibration.json")
        self._normalize_pumps()
        self._normalize_drinks()
        self._drink_index = {d["id"]: d for d in self.drinks}
        self.enabled_pumps = [p for p in self.pumps if p["enabled"]]

    def _load_json(self, filename: str) -> Any:
        with open(self.config_dir / filename, "r", encoding="utf-8") as f:
            return json.load(f)

    def _load_optional_json(self, filename: str) -> Any:
        target = self.config_dir / filename
        if not target.exists():
            return []
        return self._load_json(filename)

    def _normalize_pumps(self) -> None:
        """
        Supports:
        - preferred format: pumps.json contains pump/gpio_pin/ml_per_second
        - legacy format: pumps.json + calibration.json
        """
        by_pump_cal = {int(c["pump"]): float(c["ml_per_second"]) for c in self.calibration if "pump" in c}
        by_pump_id_cal = {c["pump_id"]: float(c["ml_per_sec"]) for c in self.calibration if "pump_id" in c}

        normalized: list[dict] = []
        for raw in self.pumps:
            if "pump" in raw:
                pump_number = int(raw["pump"])
            elif "pump_id" in raw and str(raw["pump_id"]).startswith("pump_"):
                pump_number = int(str(raw["pump_id"]).split("_")[-1])
            else:
                raise ValueError(f"Invalid pump entry in pumps.json: {raw}")

            ml_per_second = raw.get("ml_per_second")
            if ml_per_second is None and pump_number in by_pump_cal:
                ml_per_second = by_pump_cal[pump_number]
            if ml_per_second is None and raw.get("pump_id") in by_pump_id_cal:
                ml_per_second = by_pump_id_cal[raw["pump_id"]]
            if ml_per_second is None:
                raise ValueError(f"Missing calibration for pump {pump_number}")

            normalized.append(
                {
                    "pump": pump_number,
                    "gpio_pin": int(raw["gpio_pin"]),
                    "ml_per_second": float(ml_per_second),
                    "enabled": bool(raw.get("enabled", True)),
                }
            )
        self.pumps = normalized

    def _normalize_drinks(self) -> None:
        """
        Supports:
        - preferred format with `ingredients` [{pump,name,ml}]
        - legacy format with `recipe_ml` and ingredient mapping by pump config
        """
        normalized: list[dict] = []
        original_pumps = self._load_json("pumps.json")
        pump_names: dict[int, str] = {}
        for raw in original_pumps:
            pump_number = None
            if "pump" in raw:
                pump_number = int(raw["pump"])
            elif "pump_id" in raw and str(raw["pump_id"]).startswith("pump_"):
                pump_number = int(str(raw["pump_id"]).split("_")[-1])

            ingredient_name = raw.get("ingredient") or raw.get("ingredient_id")
            if pump_number is not None and ingredient_name:
                pump_names[pump_number] = ingredient_name

        for drink in self.drinks:
            if "ingredients" in drink:
                for ingredient in drink["ingredients"]:
                    pump_number = int(ingredient["pump"])
                    ingredient.setdefault("name", pump_names.get(pump_number, f"Pump {pump_number}"))
                if not drink.get("image"):
                    drink["image"] = drink["id"]
                normalized.append(drink)
                continue

            if "recipe_ml" not in drink:
                raise ValueError(f"Drink {drink.get('id')} has no ingredients or recipe_ml field")

            # Legacy fallback: resolve ingredient_id -> pump using original pumps.json if present.
            ingredients: list[dict] = []
            ingredient_to_pump: dict[str, int] = {}
            for raw in original_pumps:
                if "ingredient_id" in raw:
                    if "pump" in raw:
                        ingredient_to_pump[raw["ingredient_id"]] = int(raw["pump"])
                    elif "pump_id" in raw and str(raw["pump_id"]).startswith("pump_"):
                        ingredient_to_pump[raw["ingredient_id"]] = int(str(raw["pump_id"]).split("_")[-1])

            for step in drink["recipe_ml"]:
                ingredient_id = step["ingredient_id"]
                if ingredient_id not in ingredient_to_pump:
                    raise ValueError(f"No pump mapping found for ingredient '{ingredient_id}'")
                ingredients.append(
                    {
                        "pump": ingredient_to_pump[ingredient_id],
                        "name": ingredient_id,
                        "ml": float(step["amount_ml"]),
                    }
                )

            normalized.append(
                {
                    "id": drink["id"],
                    "name": drink["name"],
                    "image": drink.get("image") or drink["id"],
                    "ingredients": ingredients,
                }
            )

        self.drinks = normalized

    def get_drink(self, drink_id: str) -> dict | None:
        return self._drink_index.get(drink_id)

    def save_calibration(self, updates: list[dict]) -> list[dict]:
        pumps_by_number = {int(p["pump"]): p for p in self.pumps}
        for update in updates:
            pump_number = int(update["pump"])
            ml_per_second = float(update["ml_per_second"])
            if pump_number not in pumps_by_number:
                raise ValueError(f"Pump {pump_number} is not configured")
            if ml_per_second <= 0:
                raise ValueError(f"Invalid calibration for pump {pump_number}: ml_per_second must be > 0")
            pumps_by_number[pump_number]["ml_per_second"] = ml_per_second

        raw_pumps = self._load_json("pumps.json")
        for raw in raw_pumps:
            pump_number = self._pump_number_from_raw(raw)
            if pump_number in pumps_by_number:
                raw["ml_per_second"] = pumps_by_number[pump_number]["ml_per_second"]

        target = self.config_dir / "pumps.json"
        temp_target = target.with_suffix(".json.tmp")
        with open(temp_target, "w", encoding="utf-8") as f:
            json.dump(raw_pumps, f, indent=2)
            f.write("\n")
        temp_target.replace(target)

        self.pumps = list(pumps_by_number.values())
        self.enabled_pumps = [p for p in self.pumps if p["enabled"]]
        return self.pumps

    @staticmethod
    def _pump_number_from_raw(raw: dict) -> int:
        if "pump" in raw:
            return int(raw["pump"])
        if "pump_id" in raw and str(raw["pump_id"]).startswith("pump_"):
            return int(str(raw["pump_id"]).split("_")[-1])
        raise ValueError(f"Invalid pump entry in pumps.json: {raw}")
