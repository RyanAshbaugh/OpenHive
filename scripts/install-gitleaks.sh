#!/usr/bin/env bash
# install-gitleaks.sh — Downloads the gitleaks binary for local pre-commit scanning.
# Called automatically by "pnpm install" via the prepare script.
# All failures exit 0 with warnings so this never breaks installs.

set -euo pipefail

GITLEAKS_VERSION="8.22.1"
INSTALL_DIR=".gitleaks-bin"
BINARY="$INSTALL_DIR/gitleaks"

# --- Skip conditions ---

# Skip in CI
if [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "[gitleaks] CI detected — skipping local install."
  exit 0
fi

# Skip if not in a git repo (e.g. tarball install)
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[gitleaks] Not a git repo — skipping install."
  exit 0
fi

# Skip if correct version already cached
if [ -x "$BINARY" ]; then
  CURRENT_VERSION=$("$BINARY" version 2>/dev/null || echo "unknown")
  if [ "$CURRENT_VERSION" = "v$GITLEAKS_VERSION" ]; then
    exit 0
  fi
  echo "[gitleaks] Version mismatch ($CURRENT_VERSION vs v$GITLEAKS_VERSION) — updating."
fi

# --- Detect platform ---

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_TAG="darwin" ;;
  Linux)  OS_TAG="linux" ;;
  *)
    echo "[gitleaks] Unsupported OS: $OS — skipping install."
    exit 0
    ;;
esac

case "$ARCH" in
  x86_64)  ARCH_TAG="x64" ;;
  aarch64) ARCH_TAG="arm64" ;;
  arm64)   ARCH_TAG="arm64" ;;
  *)
    echo "[gitleaks] Unsupported architecture: $ARCH — skipping install."
    exit 0
    ;;
esac

# --- Download ---

TARBALL="gitleaks_${GITLEAKS_VERSION}_${OS_TAG}_${ARCH_TAG}.tar.gz"
URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${TARBALL}"

mkdir -p "$INSTALL_DIR"
TMPFILE=$(mktemp "${INSTALL_DIR}/gitleaks-download.XXXXXX")

# Clean up temp file on exit
cleanup() { rm -f "$TMPFILE"; }
trap cleanup EXIT

echo "[gitleaks] Downloading v${GITLEAKS_VERSION} for ${OS_TAG}/${ARCH_TAG}..."

if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 2 --retry-delay 1 -o "$TMPFILE" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMPFILE" "$URL"
else
  echo "[gitleaks] Neither curl nor wget found — skipping install."
  exit 0
fi

if [ ! -s "$TMPFILE" ]; then
  echo "[gitleaks] Download failed (empty file) — skipping install."
  exit 0
fi

# --- Extract & verify ---

tar -xzf "$TMPFILE" -C "$INSTALL_DIR" gitleaks 2>/dev/null || {
  echo "[gitleaks] Extraction failed — skipping install."
  exit 0
}

chmod +x "$BINARY"

if "$BINARY" version >/dev/null 2>&1; then
  echo "[gitleaks] Installed v${GITLEAKS_VERSION} at ${BINARY}"
else
  echo "[gitleaks] Binary verification failed — removing."
  rm -f "$BINARY"
  exit 0
fi
