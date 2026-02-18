#!/bin/bash
# ============================================================================
# _load-config.sh — Read .openhive/mobile.json5 and export shell variables
# ============================================================================
# Source this file to populate env vars from the project's mobile config.
#
# Reads from $OPENHIVE_MOBILE_CONFIG (default: .openhive/mobile.json5)
# relative to $PROJECT_DIR (default: cwd).
#
# Exported variables:
#   BUNDLE_ID, DEEP_LINK_SCHEME, EXPO_DEV_CLIENT_SCHEME, METRO_PORT, APP_NAME,
#   SIM_NAME, SIM_RUNTIME,
#   XCODE_WORKSPACE, XCODE_SCHEME, XCODE_CONFIGURATION,
#   AUTH_PROVIDER, KEYCHAIN_SERVICE, AUTH_ENV_FILE, AUTH_URL_ENV_VAR, AUTH_KEY_ENV_VAR

PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"
_CONFIG_FILE="${PROJECT_DIR}/${OPENHIVE_MOBILE_CONFIG:-.openhive/mobile.json5}"

if [ ! -f "$_CONFIG_FILE" ]; then
  echo "[openhive-mobile] No config found at $_CONFIG_FILE — using defaults" >&2
fi

# Use Python + json5-compatible parsing to read the config.
# Python's json module can't handle JSON5 comments/trailing commas, so we
# strip them with a minimal regex preprocessor.
eval "$(python3 - "$_CONFIG_FILE" <<'PYEOF'
import sys, json, re, os

config_path = sys.argv[1]

# Defaults (must match packages/mobile/src/config/defaults.ts)
defaults = {
    "app": {
        "bundleId": "com.example.app",
        "deepLinkScheme": "myapp",
        "expoDevClientScheme": "",
        "metroPort": 8081,
        "appName": "MyApp",
    },
    "simulator": {
        "device": "iPhone 16 Pro",
        "os": "18.2",
    },
    "build": {
        "workspace": "ios/MyApp.xcworkspace",
        "scheme": "MyApp",
        "configuration": "Debug",
    },
    "auth": {
        "provider": "supabase",
        "keychainService": "openhive-mobile-sim",
        "envFile": ".env.development",
        "urlEnvVar": "SUPABASE_URL",
        "keyEnvVar": "SUPABASE_ANON_KEY",
    },
}

def deep_merge(base, override):
    result = dict(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = deep_merge(result[k], v)
        else:
            result[k] = v
    return result

cfg = dict(defaults)
if os.path.isfile(config_path):
    with open(config_path) as f:
        raw = f.read()
    # Minimal JSON5 → JSON: strip // comments and trailing commas
    raw = re.sub(r'//.*', '', raw)
    raw = re.sub(r',\s*([}\]])', r'\1', raw)
    try:
        file_cfg = json.loads(raw)
        cfg = deep_merge(defaults, file_cfg)
    except json.JSONDecodeError as e:
        print(f'echo "[openhive-mobile] WARNING: config parse error: {e}" >&2', flush=True)

a = cfg["app"]
s = cfg["simulator"]
b = cfg["build"]
au = cfg["auth"]

def sh_export(name, val):
    # Shell-safe quoting
    val = str(val).replace("'", "'\\''")
    print(f"export {name}='{val}'")

sh_export("BUNDLE_ID", a["bundleId"])
sh_export("DEEP_LINK_SCHEME", a["deepLinkScheme"])
sh_export("EXPO_DEV_CLIENT_SCHEME", a.get("expoDevClientScheme", ""))
sh_export("METRO_PORT", a["metroPort"])
sh_export("APP_NAME", a["appName"])
sh_export("SIM_NAME", s["device"])
sh_export("SIM_RUNTIME", s["os"])
sh_export("XCODE_WORKSPACE", b["workspace"])
sh_export("XCODE_SCHEME", b["scheme"])
sh_export("XCODE_CONFIGURATION", b["configuration"])
sh_export("AUTH_PROVIDER", au["provider"])
sh_export("KEYCHAIN_SERVICE", au["keychainService"])
sh_export("AUTH_ENV_FILE", au["envFile"])
sh_export("AUTH_URL_ENV_VAR", au["urlEnvVar"])
sh_export("AUTH_KEY_ENV_VAR", au["keyEnvVar"])
PYEOF
)"
