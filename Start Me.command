#!/bin/bash
# Double-click this file in Finder to run RoninS-Ctrl-Plus on a Mac.
#
# It starts a tiny local web server (Node.js if available, otherwise Python 3)
# and opens the app in Chrome or Edge. No npm install, no internet needed.
#
# If macOS refuses to open it, see START-HERE.txt.

set -u

cd "$(dirname "$0")" || {
  echo "Could not enter the RoninS-Ctrl-Plus folder."
  read -r -n 1 -s -p "Press any key to close..."
  exit 1
}

PORT=8080
if command -v lsof >/dev/null 2>&1; then
  for candidate in 8080 8081 8082 8090 8091; do
    if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
      PORT="$candidate"
      break
    fi
  done
fi

open_browser() {
  local url="http://localhost:$1"
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "$url" >/dev/null 2>&1 || open "$url"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then
    open -a "Microsoft Edge" "$url" >/dev/null 2>&1 || open "$url"
  else
    # Safari/Firefox can run the simulator but not Web Bluetooth.
    open "$url" >/dev/null 2>&1 || true
  fi
}

SERVER_PID=""

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}

wait_forever() {
  SERVER_PID="$1"
  trap cleanup EXIT INT TERM
  wait "$SERVER_PID"
}

if command -v node >/dev/null 2>&1; then
  echo "Starting RoninS-Ctrl-Plus with Node.js ($(node --version))..."
  node tools/serve.mjs "$PORT" &
  SERVER_PID=$!
  sleep 1
  open_browser "$PORT"
  echo ""
  echo "Server: http://localhost:$PORT"
  echo "Close this window or press Ctrl+C to stop."
  wait_forever "$SERVER_PID"
  exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  echo "Starting RoninS-Ctrl-Plus with Python 3..."
  python3 tools/serve.py "$PORT" &
  SERVER_PID=$!
  sleep 1
  open_browser "$PORT"
  echo ""
  echo "Server: http://localhost:$PORT"
  echo "Close this window or press Ctrl+C to stop."
  wait_forever "$SERVER_PID"
  exit 0
fi

echo "No Node.js or Python 3 was found on this Mac."
echo ""
echo "Opening the app directly instead. The simulator still works, but"
echo "Web Bluetooth usually needs http://localhost and Chrome or Edge."
echo ""
APP="$PWD/web/index.html"
if [ -d "/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "$APP"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -a "Microsoft Edge" "$APP"
else
  open "$APP"
fi

echo ""
echo "For full Bluetooth support, install Node.js LTS from https://nodejs.org/"
echo "or install Python 3, then run this file again."
echo ""
read -r -n 1 -s -p "Press any key to close..."
