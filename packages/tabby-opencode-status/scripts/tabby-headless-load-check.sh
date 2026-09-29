#!/usr/bin/env bash
# Headless Tabby load-check: boots a SECOND, fully isolated Tabby instance
# (fresh HOME + hidden Xvfb display) with the plugin installed, and asserts the
# real loader discovers + loads it via the renderer console.
# Safe to run while the user's Tabby is live: separate user-data dir, no window.
#
# Usage: TABBY_BIN=/opt/Tabby/tabby bash scripts/tabby-headless-load-check.sh
set -euo pipefail

pack="$(cd "$(dirname "$(dirname "${BASH_SOURCE[0]}")")" && pwd)"
TABBY_BIN="${TABBY_BIN:-/opt/Tabby/tabby}"
TABBY_VERSION="${TABBY_VERSION:-local}"
home="$(mktemp -d /tmp/tabby-headless-XXXXXX)"
log="$home/boot.log"

export HOME="$home"
export ELECTRON_ENABLE_LOGGING=1
export TABBY_PLUGINS_DIR="$home/.config/tabby/plugins/node_modules/tabby-opencode-status"

echo "=== isolated HOME: $home"
echo "=== installing plugin"
node "$pack/scripts/install-plugin.js"

echo "=== booting $TABBY_BIN headless (timeout 75s)"
echo "TABBY_BIN=$TABBY_BIN TABBY_VERSION=$TABBY_VERSION" >> "$log"
set +e
timeout 75 xvfb-run -a "$TABBY_BIN" --no-sandbox --disable-gpu 2>&1 | tee "$log"
rc=$?
set -e
echo "=== tabby rc=$rc (124=timeout-kill, expected for a GUI app)"

echo "=== asserting loader output"
fail=0
if ! grep -qE "Found opencode-status in" "$log"; then
  echo "FAIL: discovery did not log 'Found opencode-status in'"
  fail=1
fi
if ! grep -qE "Loading opencode-status:" "$log"; then
  echo "FAIL: 'Loading opencode-status:' missing"
  fail=1
fi
if grep -qE "Could not load opencode-status" "$log"; then
  echo "FAIL: 'Could not load opencode-status' present"
  fail=1
fi
echo "--- relevant log lines ---"
grep -iE "opencode-status|Found |Starting with plugins" "$log" || true

if [ "$fail" -ne 0 ]; then
  echo "FINAL: FAIL ($TABBY_VERSION)"
  echo "full log: $log"
  exit 1
fi
echo "--- resolved load line ---"
grep -E "Loading opencode-status:" "$log"
echo "FINAL: PASS — plugin discovered and loaded by real Tabby ($TABBY_VERSION)"