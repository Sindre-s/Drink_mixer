#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:0
export XAUTHORITY=/home/pi/.Xauthority

# Disable screen blanking and power management
xset s off
xset -dpms
xset s noblank

# Hide cursor after inactivity
unclutter -idle 0.1 -root &

# Wait for frontend to respond before launching Chromium
for _ in {1..60}; do
  if curl -fsS http://127.0.0.1:5173 >/dev/null; then
    break
  fi
  sleep 1
done

exec /usr/bin/chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --disable-session-crashed-bubble \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  http://127.0.0.1:5173
