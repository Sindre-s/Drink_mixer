from contextlib import asynccontextmanager
from collections import deque
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .hardware.mock import MockHardware
from .hardware.raspi_gpio import RaspberryPiGPIOHardware
from .services.config_loader import ConfigStore
from .services.mixing_service import PumpController
from .services.progress_hub import ProgressHub

root_dir = Path(__file__).resolve().parents[2]
logs_dir = root_dir / "logs"
log_file = logs_dir / "mixer.log"


def configure_logging() -> logging.Logger:
    logs_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("drinkmixer")
    logger.setLevel(logging.INFO)

    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    file_handler = RotatingFileHandler(log_file, maxBytes=1_000_000, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(formatter)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)

    logger.handlers.clear()
    logger.addHandler(file_handler)
    logger.addHandler(stream_handler)
    logger.propagate = False
    return logger


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger = configure_logging()
    config = ConfigStore()
    hub = ProgressHub()
    mode = os.getenv("MIXER_MODE", "mock").lower()
    hardware = RaspberryPiGPIOHardware(config.pumps) if mode == "gpio" else MockHardware()
    mixer = PumpController(
        hardware=hardware,
        progress_hub=hub,
        pumps=config.pumps,
        mode=mode,
        logger=logger,
    )
    await mixer.initialize()
    app.state.config = config
    app.state.hub = hub
    app.state.mixer = mixer
    app.state.logger = logger
    logger.info("startup mode=%s pumps_loaded=%s drinks_loaded=%s", mode, len(config.pumps), len(config.drinks))
    logger.info("startup_pumps %s", ", ".join(f"pump{p['pump']}@gpio{p['gpio_pin']}" for p in config.pumps))
    logger.info("startup_drinks %s", ", ".join(d["id"] for d in config.drinks))
    yield
    logger.info("shutdown requested")
    await mixer.shutdown()


app = FastAPI(title="Drink Mixer API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/assets", StaticFiles(directory=root_dir / "assets"), name="assets")
frontend_dist = root_dir / "frontend" / "dist"
serve_frontend = os.getenv("SERVE_FRONTEND", "0").lower() in {"1", "true", "yes"}
if serve_frontend and frontend_dist.exists():
    app.mount("/ui-assets", StaticFiles(directory=frontend_dist / "assets"), name="ui-assets")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/drinks")
async def list_drinks():
    return app.state.config.drinks


@app.get("/api/status")
async def get_status():
    return app.state.mixer.get_status()


@app.get("/api/logs/recent")
async def get_recent_logs(lines: int = Query(default=100, ge=1, le=500)):
    if not log_file.exists():
        return {"lines": []}

    with open(log_file, "r", encoding="utf-8", errors="replace") as f:
        recent = list(deque(f, maxlen=lines))
    return {"lines": [line.rstrip("\n") for line in recent]}


@app.get("/api/config")
async def get_config():
    return {
        "pumps": app.state.config.pumps,
        "calibration": app.state.config.calibration,
    }


@app.post("/api/mix/{drink_id}")
async def start_mix(drink_id: str):
    drink = app.state.config.get_drink(drink_id)
    if drink is None:
        app.state.logger.error("start_mix_error drink_id=%s error=Drink not found", drink_id)
        raise HTTPException(status_code=404, detail="Drink not found")
    try:
        run_id = await app.state.mixer.start_mix(drink)
    except RuntimeError as exc:
        app.state.logger.error("start_mix_error drink_id=%s error=%s", drink_id, exc)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        app.state.logger.error("start_mix_error drink_id=%s error=%s", drink_id, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"run_id": run_id, "status": "started"}


@app.post("/api/stop")
async def stop_mix():
    await app.state.mixer.emergency_stop()
    return {"status": "stopped"}


@app.websocket("/ws/progress")
async def progress_socket(websocket: WebSocket):
    await websocket.accept()
    queue = await app.state.hub.subscribe()
    try:
        while True:
            msg = await queue.get()
            await websocket.send_json(msg)
    except WebSocketDisconnect:
        pass
    finally:
        await app.state.hub.unsubscribe(queue)


if serve_frontend and frontend_dist.exists():
    @app.get("/")
    async def serve_frontend_index():
        return FileResponse(frontend_dist / "index.html")


    @app.get("/{full_path:path}")
    async def serve_frontend_spa(full_path: str):
        candidate = frontend_dist / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(frontend_dist / "index.html")
