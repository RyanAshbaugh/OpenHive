#!/bin/bash
set -euo pipefail

# ============================================================================
# build-and-run.sh — Build, launch, and authenticate an app on the simulator
# ============================================================================
#
# Usage:
#   ./build-and-run.sh              # Full flow: build + launch + auth
#   ./build-and-run.sh --skip-build # Skip xcodebuild (use cached build)
#   ./build-and-run.sh --skip-auth  # Skip authentication step
#
# Environment variables (override config file):
#   SIM_NAME     — Simulator name
#   SIM_RUNTIME  — iOS version
#   METRO_PORT   — Metro bundler port
#   PROJECT_DIR  — Project root (default: cwd)
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/sim-helpers.sh"

SKIP_BUILD=false
SKIP_AUTH=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-auth)  SKIP_AUTH=true ;;
  esac
done

echo "=== $APP_NAME Simulator — Full Setup ==="
echo "  Simulator: $SIM_NAME (iOS $SIM_RUNTIME)"
echo "  Metro port: $METRO_PORT"
echo ""

# --- Step 1: Build ---
if [ "$SKIP_BUILD" = true ]; then
  echo "[1/7] Skipping build (--skip-build)"
  APP_PATH=$(get_app_path)
  if [ -z "$APP_PATH" ]; then
    echo "ERROR: No cached build found. Run without --skip-build first."
    exit 1
  fi
else
  echo "[1/7] Building for simulator..."
  cd "$PROJECT_DIR/$(dirname "$XCODE_WORKSPACE")"
  xcodebuild -workspace "$(basename "$XCODE_WORKSPACE")" \
    -scheme "$XCODE_SCHEME" \
    -sdk iphonesimulator \
    -destination "platform=iOS Simulator,name=$SIM_NAME,OS=$SIM_RUNTIME" \
    -configuration "$XCODE_CONFIGURATION" \
    build 2>&1 | tail -3
  APP_PATH=$(get_app_path)
  if [ -z "$APP_PATH" ]; then
    echo "ERROR: Could not find built ${XCODE_SCHEME}.app"
    exit 1
  fi
fi
echo "  App: $APP_PATH"

# --- Step 2: Boot simulator ---
echo "[2/7] Booting simulator..."
xcrun simctl boot "$SIM_NAME" 2>/dev/null || true
open -a Simulator
sleep 2

SIM_UDID=$(get_sim_udid)
if [ -z "$SIM_UDID" ]; then
  echo "ERROR: Could not find simulator '$SIM_NAME'"
  exit 1
fi
echo "  UDID: $SIM_UDID"

# --- Step 3: Install ---
echo "[3/7] Installing app..."
xcrun simctl install "$SIM_NAME" "$APP_PATH"

# --- Step 4: Start Metro ---
echo "[4/7] Starting Metro bundler..."
lsof -ti:$METRO_PORT | xargs kill -9 2>/dev/null || true
sleep 1

cd "$PROJECT_DIR"
npx expo start --port $METRO_PORT 2>&1 &
METRO_PID=$!

echo "  Waiting for Metro (PID: $METRO_PID)..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$METRO_PORT/status" 2>/dev/null | grep -q "running"; then
    echo "  Metro ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Metro failed to start"
    exit 1
  fi
  sleep 1
done

# --- Step 5: Launch app + connect to Metro ---
echo "[5/7] Launching app and connecting to Metro..."
xcrun simctl launch "$SIM_NAME" "$BUNDLE_ID" 2>/dev/null
sleep 2

if [ -n "$EXPO_DEV_CLIENT_SCHEME" ]; then
  xcrun simctl openurl "$SIM_NAME" \
    "${EXPO_DEV_CLIENT_SCHEME}://expo-development-client/?url=http%3A%2F%2Flocalhost%3A$METRO_PORT" 2>/dev/null
fi
sleep 3

# --- Step 6: Handle startup dialogs ---
echo "[6/7] Handling startup dialogs..."

# Dismiss "Open in <App>?" if present
if tap_button "Open" 2>/dev/null; then
  sleep 5
fi

# Wait for JS bundle to load
echo "  Waiting for JS bundle..."
sleep 8

# Dismiss Apple Account Verification if present
tap_button "Not Now" 2>/dev/null || true
sleep 1

# Dismiss React Native error screen if present
tap_button "Dismiss (ESC)" 2>/dev/null || true
sleep 2

# Screenshot to verify state
SCREEN=$(screenshot "step6-after-dialogs")
echo "  Screenshot: $SCREEN"

# --- Step 7: Authenticate ---
if [ "$SKIP_AUTH" = true ]; then
  echo "[7/7] Skipping authentication (--skip-auth)"
else
  echo "[7/7] Authenticating..."
  "$SCRIPTS_DIR/authenticate-sim.sh" || echo "  WARNING: Authentication failed. You can sign in manually."

  # Tap "Open" if the deep link confirmation dialog appears
  sleep 3
  tap_button "Open" 2>/dev/null || true
  sleep 5

  SCREEN=$(screenshot "step7-authenticated")
  echo "  Screenshot: $SCREEN"
fi

# --- Done ---
echo ""
echo "==========================================="
echo "  $APP_NAME is running on $SIM_NAME"
echo "  Metro PID: $METRO_PID"
echo "==========================================="
echo ""
echo "Useful commands:"
echo "  Screenshot:  source $SCRIPTS_DIR/sim-helpers.sh && screenshot 'name'"
echo "  UI elements: source $SCRIPTS_DIR/sim-helpers.sh && list_ui_elements"
echo "  Tap button:  source $SCRIPTS_DIR/sim-helpers.sh && tap_button 'Label'"
echo "  Stop Metro:  kill $METRO_PID"
echo "  Stop sim:    xcrun simctl shutdown '$SIM_NAME'"
