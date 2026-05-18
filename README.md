# Drink Mixer (Raspberry Pi + Touchscreen)

FastAPI + React cocktail machine UI with WebSocket progress updates, mock mode for laptop development, and Raspberry Pi GPIO mode for hardware control.

## Safety Disclaimer

Before using real ingredients, validate all pump timings, relay behavior, and emergency-stop behavior with water only.

## Features

- FastAPI backend (`backend/app/main.py`)
- React + Vite frontend (`frontend/`)
- WebSocket progress stream (`/ws/progress`)
- Mock hardware mode for non-Pi development
- GPIO hardware mode for Raspberry Pi
- Rotating backend logs in `logs/mixer.log`
- Kiosk deployment files in `deploy/raspi/`

## Project Structure

```text
backend/
  app/
    hardware/
    services/
    main.py
frontend/
  src/
config/
  drinks.json
  pumps.json
  calibration.json
assets/
  drinks/
deploy/
  raspi/
```

## Installation

### Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### Frontend

```bash
cd frontend
npm ci
```

## Development (Backend + Frontend Together)

Run backend (mock mode, laptop-safe):

```bash
cd /path/to/Drinkmixer
source .venv/bin/activate
export MIXER_MODE=mock
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

Run frontend (second terminal):

```bash
cd /path/to/Drinkmixer/frontend
export VITE_API_BASE=http://127.0.0.1:8000
npm run dev -- --host 0.0.0.0 --port 5173
```

Open:
- Frontend: `http://127.0.0.1:5173`
- Backend health: `http://127.0.0.1:8000/api/health`

## API Contract

The frontend uses these backend endpoints:

- `GET /api/health`
- `GET /api/drinks`
- `GET /api/status`
- `GET /api/config`
- `GET /api/logs/recent?lines=100`
- `PUT /api/config/calibration`
- `POST /api/mix/{drink_id}`
- `POST /api/stop`
- `WS /ws/progress`

### WebSocket Progress Events

- `started`
- `pouring`
- `step_done`
- `completed`
- `error`
- `stopped`

## Logging and Machine Status

Backend logs are written to:

- `logs/mixer.log`
- rotated backups: `logs/mixer.log.1`, etc.

Lifecycle logging includes:

- drink started
- drink completed
- emergency stop
- mix errors
- startup summary of loaded pumps and drinks

`GET /api/status` includes:

- current state
- current drink
- backend uptime
- last completed drink
- number of drinks made today
- mode (`mock` or `real`)

## Pump Safety Behavior

Pumps are explicitly turned off on:

- startup (`hardware.initialize()` calls `all_off`)
- emergency stop (`/api/stop`)
- mix error
- backend shutdown
- cancelled active mix task

## Drink Image Asset System

Drink images are served from `assets/drinks/`.

Each drink in `config/drinks.json` should include an `image` field:

```json
{
  "id": "rum_coke",
  "name": "Rum & Coke",
  "image": "rum_coke.jpg"
}
```

Supported formats:

- `.jpg` / `.jpeg`
- `.png`
- `.webp`

Frontend fallback behavior:

- if extension is omitted (`"image": "rum_coke"`), UI tries `.jpg`, `.jpeg`, `.png`, `.webp`
- if all fail, UI shows gradient placeholder with drink name
- UI does not break on missing/bad image URLs

To replace placeholders with your photos:

1. Put files in `assets/drinks/`
2. Set `image` in `config/drinks.json` to filename (or extensionless base)
3. Restart backend in production

## Calibration Workflow

1. Set `MIXER_MODE=mock` and validate UI flow without hardware.
2. Move to Raspberry Pi and `MIXER_MODE=gpio`.
3. Prime each line with water.
4. Dispense known volumes (for example 100 ml) and measure output.
5. Update `ml_per_second` from the Admin screen, or edit `config/pumps.json`.
6. Repeat until measured output matches target within tolerance.

## Build Frontend (Production)

```bash
cd /path/to/Drinkmixer/frontend
npm run build
```

This creates `frontend/dist`.

To serve built frontend from FastAPI:

```bash
export SERVE_FRONTEND=1
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

In this mode, UI is served from `http://127.0.0.1:8000`.

## Raspberry Pi GPIO Mode

Run directly on Pi:

```bash
cd /home/pi/Drinkmixer
source .venv/bin/activate
export MIXER_MODE=gpio
export SERVE_FRONTEND=1
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

`config/pumps.json` defines pump-to-GPIO mapping.

## Raspberry Pi Kiosk Deployment

Use provided files:

- `deploy/raspi/drinkmixer-backend.service`
- `deploy/raspi/drinkmixer-frontend.service`
- `deploy/raspi/drinkmixer-kiosk.service`
- `deploy/raspi/kiosk.sh`

Install dependencies:

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip nodejs npm chromium-browser unclutter curl
```

Enable services:

```bash
cd /home/pi/Drinkmixer
sudo cp deploy/raspi/drinkmixer-backend.service /etc/systemd/system/
sudo cp deploy/raspi/drinkmixer-frontend.service /etc/systemd/system/
sudo cp deploy/raspi/drinkmixer-kiosk.service /etc/systemd/system/
sudo chmod +x deploy/raspi/kiosk.sh
sudo systemctl daemon-reload
sudo systemctl enable --now drinkmixer-backend
sudo systemctl enable --now drinkmixer-frontend
sudo systemctl enable --now drinkmixer-kiosk
```

Enable desktop auto-login:

```bash
sudo raspi-config
```

Then:
`System Options` -> `Boot / Auto Login` -> `Desktop Autologin`.

## Example Commands (Quick Reference)

Run backend:

```bash
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

Run frontend:

```bash
cd frontend && npm run dev -- --host 0.0.0.0 --port 5173
```

Build frontend:

```bash
cd frontend && npm run build
```

Run on Raspberry Pi:

```bash
export MIXER_MODE=gpio
export SERVE_FRONTEND=1
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

Service operations:

```bash
sudo systemctl restart drinkmixer-backend
sudo systemctl restart drinkmixer-frontend
sudo systemctl restart drinkmixer-kiosk
journalctl -u drinkmixer-backend -f
```

## Troubleshooting

### Touchscreen not working

- Confirm ribbon/USB connection and power.
- Run `xinput list` and verify touch device appears.
- Reboot after display config changes.
- Check kiosk is using the correct `DISPLAY=:0`.

### Relays inverted (pump turns on when expected off)

- Relay boards can be active-low.
- If inverted, adjust hardware adapter logic (`active_high` in `raspi_gpio.py`) and retest with water.
- Verify relay module jumper/settings.

### Pump not running

- Check pump power supply and ground reference.
- Verify GPIO pin in `config/pumps.json` matches wiring.
- Confirm pump is enabled and calibration is > 0.
- Check backend logs: `tail -f logs/mixer.log`.

### Wrong amount dispensed

- Recalibrate `ml_per_second` for that pump.
- Prime lines before measurement.
- Measure multiple runs and average.
- Check for tube kinks, leaks, or voltage drop under load.

### App not opening on boot

- Check service status:
  - `systemctl status drinkmixer-backend`
  - `systemctl status drinkmixer-frontend`
  - `systemctl status drinkmixer-kiosk`
- Check kiosk logs:
  - `journalctl -u drinkmixer-kiosk -f`
- Confirm desktop autologin is enabled.
- Confirm `kiosk.sh` is executable and URL matches active frontend mode (`:5173` or `:8000`).
