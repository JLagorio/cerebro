#!/usr/bin/env bash
#
# Build Cerebro.app on this Mac and install it.
#
# One command, from a clean checkout to an app in /Applications. Everything it
# needs beyond Xcode's command line tools it checks for by name and explains
# rather than assumes, because a build that fails halfway through with a linker
# error is worse than one that never starts.
#
#   usage: scripts/mac-build.sh [--no-install] [--universal]
#
set -euo pipefail

cd "$(dirname "$0")/.."

# This Mac's own architecture by default: building for the machine you are
# standing at compiles the dependency tree once instead of twice. --universal
# builds the one that also runs on the other kind of Mac.
case "$(uname -m)" in
  arm64) TARGET="aarch64-apple-darwin" ;;
  *)     TARGET="x86_64-apple-darwin" ;;
esac

INSTALL=1
# Written as `if` rather than `[ ... ] && INSTALL=0`: under `set -e` a trailing
# `&&` whose test fails ends the script, which is every run without the flag.
for arg in "$@"; do
  if [ "$arg" = "--no-install" ]; then
    INSTALL=0
  elif [ "$arg" = "--universal" ]; then
    TARGET="universal-apple-darwin"
  fi
done

APP="src-tauri/target/$TARGET/release/bundle/macos/Cerebro.app"

die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script builds the Mac app; run it on macOS."

echo "==> Checking the toolchain"
xcode-select -p >/dev/null 2>&1 || die "Xcode command line tools missing. Run: xcode-select --install"
command -v cargo >/dev/null || die "Rust missing. Install it from https://rustup.rs"
command -v node  >/dev/null || die "Node missing. Install Node 20 or newer from https://nodejs.org"
command -v pnpm  >/dev/null || die "pnpm missing. Run: corepack enable && corepack prepare pnpm@10 --activate"

# rustup is needed to ADD a target, and only a target this Rust does not
# already have needs adding. Every Rust can build for the machine it is
# standing on, so the ordinary native build needs no rustup at all — demanding
# it turned Homebrew's Rust, which builds this app perfectly well, into a hard
# stop at the toolchain check. A universal binary is the case that genuinely
# needs it: it is linked from BOTH single-architecture builds, so the other
# architecture's standard library has to be fetched, and a non-rustup Rust has
# no way to fetch it. Say that here rather than let the linker fail ten
# minutes in. Adding a target already present is a no-op.
HOST_TARGET="$(rustc -vV | awk '/^host: /{ print $2 }')"
if [ "$TARGET" = "universal-apple-darwin" ]; then
  command -v rustup >/dev/null || die "a universal build needs rustup to add the second architecture (this Rust cannot). Install it from https://rustup.rs, or drop --universal to build for this Mac only."
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
elif [ "$TARGET" != "$HOST_TARGET" ]; then
  # Rust is for a different architecture than the Mac reports — an x86_64
  # toolchain under Rosetta, say. Cross-compiling back needs the target added.
  command -v rustup >/dev/null || die "this Rust builds for $HOST_TARGET, not $TARGET, and cannot add targets. Install rustup from https://rustup.rs"
  rustup target add "$TARGET" >/dev/null
fi

echo "==> Installing dependencies"
pnpm install --frozen-lockfile

echo "==> Building for $TARGET (the first run compiles the Rust side and takes a while)"
pnpm tauri build --ci --target "$TARGET" --bundles app

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
