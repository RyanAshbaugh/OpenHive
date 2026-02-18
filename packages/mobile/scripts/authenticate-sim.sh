#!/bin/bash
set -euo pipefail

# ============================================================================
# authenticate-sim.sh — Sign into the app on the simulator automatically
# ============================================================================
#
# Reads credentials from macOS Keychain, calls the auth API, then injects
# session tokens into the app via deep link.
#
# Prerequisites:
#   - Run setup-credentials.sh first
#   - App must be running on the simulator
#
# Usage:
#   ./authenticate-sim.sh
#   SIM_NAME="iPhone Air" ./authenticate-sim.sh
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/sim-helpers.sh"

python3 - "$PROJECT_DIR" "$SIM_NAME" "$KEYCHAIN_SERVICE" "$AUTH_ENV_FILE" \
  "$AUTH_URL_ENV_VAR" "$AUTH_KEY_ENV_VAR" "$DEEP_LINK_SCHEME" "$AUTH_PROVIDER" <<'PYEOF'
import subprocess, json, urllib.request, urllib.error, sys

project_dir = sys.argv[1]
sim_name = sys.argv[2]
keychain_service = sys.argv[3]
env_file = sys.argv[4]
url_env_var = sys.argv[5]
key_env_var = sys.argv[6]
deep_link_scheme = sys.argv[7]
auth_provider = sys.argv[8]

def get_cred(account):
    try:
        return subprocess.check_output(
            ["security", "find-generic-password", "-s", keychain_service, "-a", account, "-w"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        return ""

print("[1/3] Reading credentials from Keychain...")
email = get_cred("email")
password = get_cred("password")

if not email or not password:
    print(f"ERROR: No credentials found. Run setup-credentials.sh first.")
    print(f"  Keychain service: {keychain_service}")
    sys.exit(1)
print(f"  Account: {email}")

print("[2/3] Authenticating with API...")
env = {}
env_path = f"{project_dir}/{env_file}"
try:
    with open(env_path) as f:
        for line in f:
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v
except FileNotFoundError:
    print(f"ERROR: Env file not found: {env_path}")
    sys.exit(1)

api_url = env.get(url_env_var, "")
api_key = env.get(key_env_var, "")

if not api_url or not api_key:
    print(f"ERROR: Missing {url_env_var} or {key_env_var} in {env_file}")
    sys.exit(1)

if auth_provider == "supabase":
    url = api_url + "/auth/v1/token?grant_type=password"
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(url, data=body, headers={"apikey": api_key, "Content-Type": "application/json"})

    try:
        with urllib.request.urlopen(req) as resp:
            d = json.loads(resp.read())
            access_token = d["access_token"]
            refresh_token = d["refresh_token"]
            print("  Got session tokens")
    except urllib.error.HTTPError as e:
        d = json.loads(e.read())
        msg = d.get("error_description", d.get("error", d.get("msg", str(d))))
        print(f"ERROR: Authentication failed: {msg}")
        sys.exit(1)

    print("[3/3] Injecting session into app...")
    deep_link = f"{deep_link_scheme}://auth/callback#access_token={access_token}&refresh_token={refresh_token}&token_type=bearer"
    subprocess.run(["xcrun", "simctl", "openurl", sim_name, deep_link], check=True)
else:
    print(f"ERROR: Unsupported auth provider: {auth_provider}")
    print("  Supported providers: supabase")
    sys.exit(1)

print()
print("=== Authentication complete ===")
print(f"  Account: {email}")
print(f"  Simulator: {sim_name}")
print()
print("Note: You may need to tap 'Open' if the confirmation dialog appears.")
PYEOF
