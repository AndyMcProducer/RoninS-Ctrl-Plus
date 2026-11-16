#!/bin/bash
# Double-click this file in Finder to run RoninS-Ctrl-Plus on a Mac.
#
# It starts a tiny local web server and opens the app in Chrome or Edge.
# The bundled server needs nothing installed. If it cannot run, Node.js or
# Python 3 is used instead. No npm install, no internet needed.
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

run_server() {
  # $1 = human label, remaining args = command
  local label="$1"
  shift
  echo "Starting RoninS-Ctrl-Plus with $label..."
  "$@" &
  SERVER_PID=$!
  sleep 1
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    SERVER_PID=""
    return 1
  fi
  trap cleanup EXIT INT TERM
  open_browser "$PORT"
  echo ""
  echo "Server: http://localhost:$PORT"
  echo "Close this window or press Ctrl+C to stop."
  wait "$SERVER_PID"
  exit 0
}

BUNDLED=""
case "$(uname -m)" in
  arm64) BUNDLED="runtime/ronserver-darwin-arm64" ;;
  x86_64) BUNDLED="runtime/ronserver-darwin-amd64" ;;
esac

if [ -n "$BUNDLED" ] && [ -f "$BUNDLED" ]; then
  # The zip may carry a quarantine flag. Clear it so the bundled server runs
  # without a Gatekeeper prompt. Harmless if the flag is not there.
  chmod +x "$BUNDLED" 2>/dev/null || true
  xattr -d com.apple.quarantine "$BUNDLED" 2>/dev/null || true
  run_server "the bundled server" "$PWD/$BUNDLED" "$PORT"
fi

if command -v node >/dev/null 2>&1; then
  run_server "Node.js ($(node --version 2>/dev/null))" node tools/serve.mjs "$PORT"
fi

if command -v python3 >/dev/null 2>&1; then
  run_server "Python 3" python3 tools/serve.py "$PORT"
fi

echo "The bundled server could not start, and no Node.js or Python 3 was found."
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
echo "To fix this, unzip the download again in full, keeping the runtime folder"
echo "next to this file. Or install Node.js LTS from https://nodejs.org/ and"
echo "run this file again."
echo ""
read -r -n 1 -s -p "Press any key to close..."
