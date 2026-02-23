#!/bin/bash
set -euo pipefail

# ============================================================================
# stop.sh — Stop Metro bundler and optionally shut down simulator
# ============================================================================
#
# Usage:
#   ./stop.sh              # Stop this project's Metro session
#   ./stop.sh --sim        # Also shut down the simulator
#
# The tmux session name is derived from the project's APP_NAME in config,
# so stopping one project's Metro won't affect another.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_load-config.sh"

STOP_SIM=false
for arg in "$@"; do
  case "$arg" in
    --sim) STOP_SIM=true ;;
  esac
done

echo "=== Stopping $APP_NAME ==="

# Stop Metro tmux session
if tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -qx "$METRO_SESSION"; then
  echo "  Killing Metro session: $METRO_SESSION"
  tmux kill-session -t "$METRO_SESSION"
  echo "  Metro stopped"
else
  echo "  No Metro session found ($METRO_SESSION)"
fi

# Kill any leftover process on the Metro port
if lsof -ti:"$METRO_PORT" >/dev/null 2>&1; then
  echo "  Killing remaining process on port $METRO_PORT..."
  lsof -ti:"$METRO_PORT" | xargs kill -9 2>/dev/null || true
fi

# Optionally stop simulator
if [ "$STOP_SIM" = true ]; then
  echo "  Shutting down simulator: $SIM_NAME"
  xcrun simctl shutdown "$SIM_NAME" 2>/dev/null || echo "  (Simulator not running)"
fi

echo "Done"
