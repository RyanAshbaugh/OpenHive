#!/bin/bash
set -euo pipefail

# ============================================================================
# setup-credentials.sh — Store simulation credentials in macOS Keychain
# ============================================================================
#
# Uses Python internally to avoid all shell interpretation of special
# characters in passwords ($, !, &, ^, *, etc.)
#
# Usage:
#   ./setup-credentials.sh              # Interactive prompt
#   ./setup-credentials.sh --verify     # Test stored credentials against API
#   ./setup-credentials.sh --delete     # Remove stored credentials
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/sim-helpers.sh"

if [ "${1:-}" = "--delete" ]; then
  security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "email" 2>/dev/null || true
  security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "password" 2>/dev/null || true
  echo "Credentials deleted from keychain service: $KEYCHAIN_SERVICE"
  exit 0
fi

if [ "${1:-}" = "--verify" ]; then
  PYSCRIPT_V=$(mktemp /tmp/verify-creds-XXXXXX)
  trap "rm -f $PYSCRIPT_V" EXIT
  cat > "$PYSCRIPT_V" <<PYEOF_HEADER
PROJECT_DIR = "$PROJECT_DIR"
KEYCHAIN_SERVICE = "$KEYCHAIN_SERVICE"
AUTH_ENV_FILE = "$AUTH_ENV_FILE"
AUTH_URL_ENV_VAR = "$AUTH_URL_ENV_VAR"
AUTH_KEY_ENV_VAR = "$AUTH_KEY_ENV_VAR"
AUTH_PROVIDER = "$AUTH_PROVIDER"
PYEOF_HEADER
  cat >> "$PYSCRIPT_V" <<'PYEOF'
import subprocess, json, urllib.request, urllib.error, sys

def get_cred(account):
    try:
        return subprocess.check_output(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        return ""

email = get_cred("email")
password = get_cred("password")

if not email or not password:
    print(f"No credentials stored. Run setup-credentials.sh first.")
    print(f"  Keychain service: {KEYCHAIN_SERVICE}")
    sys.exit(1)

print(f"Email: {email}")
print(f"Password: {len(password)} chars")

env = {}
env_path = f"{PROJECT_DIR}/{AUTH_ENV_FILE}"
with open(env_path) as f:
    for line in f:
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.strip().split("=", 1)
            env[k] = v

api_url = env.get(AUTH_URL_ENV_VAR, "")
api_key = env.get(AUTH_KEY_ENV_VAR, "")

if AUTH_PROVIDER == "supabase":
    url = api_url + "/auth/v1/token?grant_type=password"
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(url, data=body, headers={"apikey": api_key, "Content-Type": "application/json"})

    try:
        with urllib.request.urlopen(req) as resp:
            d = json.loads(resp.read())
            print(f"\nSUCCESS")
            print(f"  User ID: {d['user']['id']}")
            print(f"  Email:   {d['user']['email']}")
    except urllib.error.HTTPError as e:
        d = json.loads(e.read())
        msg = d.get("error_description", d.get("error", d.get("msg", str(d))))
        print(f"\nFAILED: {msg}")
        sys.exit(1)
else:
    print(f"Unsupported auth provider: {AUTH_PROVIDER}")
    sys.exit(1)
PYEOF
  exec python3 "$PYSCRIPT_V"
fi

# --- Interactive credential setup via Python (bypasses all shell interpretation) ---
PYSCRIPT=$(mktemp /tmp/setup-creds-XXXXXX)
trap "rm -f $PYSCRIPT" EXIT

cat > "$PYSCRIPT" <<PYEOF_HEADER
KEYCHAIN_SERVICE = "$KEYCHAIN_SERVICE"
APP_NAME = "$APP_NAME"
PYEOF_HEADER

cat >> "$PYSCRIPT" <<'PYEOF'
import subprocess, getpass, sys

def get_cred(account):
    try:
        return subprocess.check_output(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        return ""

def delete_cred(account):
    subprocess.run(
        ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
        capture_output=True)

def store_cred(account, value):
    delete_cred(account)
    subprocess.run(
        ["security", "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value],
        check=True)

print(f"=== {APP_NAME} Simulation — Credential Setup ===")
print()
print(f"Stores test account credentials in macOS Keychain (service: {KEYCHAIN_SERVICE}).")
print("Password input is hidden and immune to shell special characters.")
print()

existing = get_cred("email")
if existing:
    print(f"Existing credentials found for: {existing}")
    resp = input("Update credentials? (y/N): ").strip().lower()
    if resp != "y":
        print("Keeping existing credentials.")
        sys.exit(0)

email = input("Test account email: ").strip()
password = getpass.getpass("Test account password: ")

store_cred("email", email)
store_cred("password", password)

# Verify round-trip
stored_email = get_cred("email")
stored_pw = get_cred("password")

print()
if stored_email == email and stored_pw == password:
    print(f"Credentials stored and verified.")
    print(f"  Email: {stored_email}")
    print(f"  Password: {len(stored_pw)} chars (round-trip OK)")
else:
    print("WARNING: Round-trip verification failed!")
    if stored_pw != password:
        print(f"  Password: stored {len(stored_pw)} chars vs input {len(password)} chars")
        for i, (a, b) in enumerate(zip(password, stored_pw)):
            if a != b:
                print(f"  First diff at position {i}: input={a!r} stored={b!r}")
                break
    sys.exit(1)

print()
print("To verify against the API:")
print("  ./setup-credentials.sh --verify")
PYEOF

exec python3 "$PYSCRIPT"
