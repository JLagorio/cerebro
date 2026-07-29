#!/usr/bin/env bash
#
# Build Cerebro.app on this Mac and install it.
#
# One command, from a clean checkout to an app in /Applications. Everything it
# needs beyond Xcode's command line tools it checks for by name and explains
# rather than assumes, because a build that fails halfway through with a linker
# error is worse than one that never starts.
#
#   usage: scripts/mac-build.sh [--no-install]
#
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="universal-apple-darwin"
APP="target/$TARGET/release/bundle/macos/Cerebro.app"
INSTALL=1
[ "${1:-}" = "--no-install" ] && INSTALL=0

die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script builds the Mac app; run it on macOS."

echo "==> Checking the toolchain"
xcode-select -p >/dev/null 2>&1 || die "Xcode command line tools missing. Run: xcode-select --install"
command -v cargo >/dev/null || die "Rust missing. Install it from https://rustup.rs"
command -v node  >/dev/null || die "Node missing. Install Node 20 or newer from https://nodejs.org"
command -v pnpm  >/dev/null || die "pnpm missing. Run: corepack enable && corepack prepare pnpm@10 --activate"

# A universal binary is built from both single-architecture targets, so both
# have to be installed. Adding one already present is a no-op.
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

echo "==> Installing dependencies"
pnpm install --frozen-lockfile

echo "==> Building (first run compiles the Rust side and takes a while)"
pnpm tauri build --target "$TARGET" --bundles app

./scripts/mac-package.sh "$APP"

if [ "$INSTALL" -eq 0 ]; then
  echo
  echo "Built $APP (not installed)."
  exit 0
fi

echo "==> Installing to /Applications"
# A running copy cannot be replaced in place.
osascript -e 'quit app "Cerebro"' >/dev/null 2>&1 || true
rm -rf "/Applications/Cerebro.app"
cp -R "$APP" "/Applications/Cerebro.app"
# Locally built code was never downloaded, so there is normally no quarantine
# flag — clearing it anyway keeps this working when the app arrived some other
# way, and costs nothing when there is nothing to clear.
xattr -dr com.apple.quarantine "/Applications/Cerebro.app" 2>/dev/null || true

echo
echo "Installed /Applications/Cerebro.app"

if command -v claude >/dev/null 2>&1; then
  echo "Claude Code found at $(command -v claude) — the assistant panel (Cmd+J) will use it."
else
  echo "Note: the Claude Code CLI was not found on your PATH. The app works without"
  echo "it, but the assistant panel needs it: https://claude.com/claude-code"
fi

open -a "Cerebro"
