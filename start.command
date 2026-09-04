#!/bin/bash
# Double-click this file to launch the scale reader.
#
# Why a local server rather than opening index.html directly:
# Chrome attaches a Bluetooth permission to an ORIGIN. A file:// page has no
# proper origin, so the grant cannot persist and the device chooser reappears on
# every reload. http://localhost is a real, stable origin and a secure context,
# so the grant sticks and the page reconnects to your scale with no chooser.
set -e
cd "$(dirname "$0")"
PORT=8777

# Reuse a server already listening on this port rather than failing to bind.
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Server already running on port $PORT."
else
  echo "Starting a local server on port $PORT…"
  python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

URL="http://localhost:$PORT/index.html"
echo "Opening $URL"
open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"

cat <<'NOTE'

Scale reader is running at the URL above.

If the device chooser still appears every time, both of these Chrome flags need
to be Enabled, then Relaunch:

  chrome://flags/#enable-experimental-web-platform-features
  chrome://flags/#enable-web-bluetooth-new-permissions-backend

The second one is what makes Chrome remember the scale between page loads.

Leave this window open while you use the page. Close it to stop the server.
NOTE

# Keep the server attached to this window so closing it stops the server.
wait
