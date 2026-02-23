#!/bin/bash
# ============================================================================
# sim-helpers.sh — Shared helper functions for simulation scripts
# ============================================================================
# Source this file: source "$(dirname "$0")/sim-helpers.sh"
#
# Requires: _load-config.sh variables to be loaded (done automatically below)

# --- Load config ---
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  _HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  _HELPERS_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

# Allow env overrides, then fall back to config file
_PREV_SIM_NAME="${SIM_NAME:-}"
_PREV_METRO_PORT="${METRO_PORT:-}"

source "$_HELPERS_DIR/_load-config.sh"

# Restore explicit env overrides (they take priority over config file)
[ -n "$_PREV_SIM_NAME" ] && export SIM_NAME="$_PREV_SIM_NAME"
[ -n "$_PREV_METRO_PORT" ] && export METRO_PORT="$_PREV_METRO_PORT"

# --- Derived paths ---
IOS_DIR="$PROJECT_DIR/$(dirname "$XCODE_WORKSPACE")"
SCRIPTS_DIR="$_HELPERS_DIR"
SCREENSHOTS_DIR="$PROJECT_DIR/.openhive/screenshots"
RECORDINGS_DIR="$PROJECT_DIR/.openhive/recordings"

# --- Simulator helpers ---

# Resolve simulator UDID (cached after first call)
_SIM_UDID=""
get_sim_udid() {
  if [ -n "$_SIM_UDID" ]; then
    echo "$_SIM_UDID"
    return
  fi
  _SIM_UDID=$(xcrun simctl list devices available -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data['devices'].items():
    for d in devices:
        if d['isAvailable'] and d['name'] == '$SIM_NAME':
            print(d['udid'])
            sys.exit(0)
" 2>/dev/null)
  echo "$_SIM_UDID"
}

# Find the built .app path using Xcode scheme name
get_app_path() {
  find "$HOME/Library/Developer/Xcode/DerivedData" \
    -path "*/${XCODE_SCHEME}-*/Build/Products/${XCODE_CONFIGURATION}-iphonesimulator/${XCODE_SCHEME}.app" \
    -maxdepth 5 2>/dev/null | head -1
}

# Read a credential from macOS Keychain
get_credential() {
  local account="$1"
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$account" -w 2>/dev/null || echo ""
}

# Take a screenshot and optionally display the path
screenshot() {
  local name="${1:-screenshot-$(date +%s)}"
  local path="$SCREENSHOTS_DIR/${name}.png"
  mkdir -p "$SCREENSHOTS_DIR"
  xcrun simctl io "$SIM_NAME" screenshot "$path" 2>/dev/null
  echo "$path"
}

# Snapshot the UI accessibility tree, return JSON array of elements
snapshot_ui() {
  local sim_id
  sim_id=$(get_sim_udid)
  xcodebuildmcp ui-automation snapshot-ui --simulator-id "$sim_id" 2>&1
}

# Find a button by label and return "x y" center coordinates (or empty)
find_button() {
  local label="$1"
  local sim_id
  sim_id=$(get_sim_udid)
  xcodebuildmcp ui-automation snapshot-ui --simulator-id "$sim_id" 2>&1 | python3 -c "
import json, sys
text = sys.stdin.read()
try:
    start = text.index('[')
    end = text.rindex(']') + 1
    data = json.loads(text[start:end])
    def find(nodes):
        for n in nodes:
            if n.get('AXLabel') == '$label' and n.get('role') == 'AXButton':
                f = n['frame']
                print(f\"{f['x'] + f['width']/2:.0f} {f['y'] + f['height']/2:.0f}\")
                return True
            if find(n.get('children', [])):
                return True
        return False
    find(data)
except:
    pass
" 2>/dev/null
}

# Find any element (not just buttons) by label
find_element() {
  local label="$1"
  local sim_id
  sim_id=$(get_sim_udid)
  xcodebuildmcp ui-automation snapshot-ui --simulator-id "$sim_id" 2>&1 | python3 -c "
import json, sys
text = sys.stdin.read()
try:
    start = text.index('[')
    end = text.rindex(']') + 1
    data = json.loads(text[start:end])
    def find(nodes):
        for n in nodes:
            if n.get('AXLabel') == '$label':
                f = n['frame']
                print(f\"{f['x'] + f['width']/2:.0f} {f['y'] + f['height']/2:.0f}\")
                return True
            if find(n.get('children', [])):
                return True
        return False
    find(data)
except:
    pass
" 2>/dev/null
}

# Tap at coordinates
tap() {
  local x="$1"
  local y="$2"
  local sim_id
  sim_id=$(get_sim_udid)
  xcodebuildmcp ui-automation tap --simulator-id "$sim_id" --x "$x" --y "$y" 2>/dev/null
}

# Find a button by label and tap it. Returns 0 on success, 1 if not found.
tap_button() {
  local label="$1"
  local coords
  coords=$(find_button "$label")
  if [ -n "$coords" ]; then
    local x=$(echo "$coords" | cut -d' ' -f1)
    local y=$(echo "$coords" | cut -d' ' -f2)
    echo "  Tapping '$label' at ($x, $y)"
    tap "$x" "$y"
    return 0
  fi
  return 1
}

# Wait for a specific button to appear (polls snapshot_ui)
wait_for_button() {
  local label="$1"
  local timeout="${2:-15}"
  for i in $(seq 1 "$timeout"); do
    local coords
    coords=$(find_button "$label")
    if [ -n "$coords" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Wait for any element with a matching label
wait_for_element() {
  local label="$1"
  local timeout="${2:-15}"
  for i in $(seq 1 "$timeout"); do
    local coords
    coords=$(find_element "$label")
    if [ -n "$coords" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Dismiss any visible system alerts or error overlays.
# Tries common iOS alert button labels and React Native LogBox close buttons.
# Safe to call even when no alerts are present.
dismiss_alerts() {
  local dismissed=false
  for label in "Not Now" "OK" "Allow" "Cancel" "Close" "Dismiss" "Later" "Remind Me Later"; do
    if tap_button "$label" 2>/dev/null; then
      dismissed=true
      sleep 0.5
    fi
  done
  # React Native LogBox close button (the ✕ in the bottom error bar)
  # It's typically a small element — look for any close/dismiss element
  tap_button "Dismiss (ESC)" 2>/dev/null && dismissed=true || true
  if [ "$dismissed" = true ]; then
    echo "  Dismissed alert(s)"
    sleep 0.5
  fi
}

# List all visible labels on screen (useful for debugging)
list_ui_elements() {
  local sim_id
  sim_id=$(get_sim_udid)
  xcodebuildmcp ui-automation snapshot-ui --simulator-id "$sim_id" 2>&1 | python3 -c "
import json, sys
text = sys.stdin.read()
try:
    start = text.index('[')
    end = text.rindex(']') + 1
    data = json.loads(text[start:end])
    def show(nodes, depth=0):
        for n in nodes:
            label = n.get('AXLabel', '')
            role = n.get('role', '')
            f = n.get('frame', {})
            if label and f:
                cx = f['x'] + f['width']/2
                cy = f['y'] + f['height']/2
                indent = '  ' * depth
                print(f'{indent}{role} \"{label}\" ({cx:.0f},{cy:.0f})')
            show(n.get('children', []), depth+1)
    show(data)
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
" 2>/dev/null
}
