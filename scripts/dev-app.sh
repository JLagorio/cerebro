#!/usr/bin/env bash
#
# Run the real app against a real folder, with hot reload.
#
# `pnpm dev` serves the frontend alone against an in-memory vault and a scripted
# assistant, which is the right default for UI work and needs no Rust. It is
# also indistinguishable from the real app on screen, so it is the wrong thing
# to be running when you are trying to find out whether Cerebro works on your
# own notes. This script is the other mode: your folder on disk, your `claude`
# binary, the same edit-and-reload loop.
#
# Everything it needs it checks for by name first. A dev loop that dies six
# minutes in on a missing system library has already wasted the six minutes.
#
#   usage: scripts/dev-app.sh [-- <extra tauri dev args>]
#
set -euo pipefail

cd "$(dirname "$0")/.."

die() { echo "error: $*" >&2; exit 1; }

echo "==> Checking the toolchain"
command -v cargo >/dev/null || die "Rust missing. Install it from https://rustup.rs"
command -v node  >/dev/null || die "Node missing. Install Node 20 or newer from https://nodejs.org"
command -v pnpm  >/dev/null || die "pnpm missing. Run: corepack enable && corepack prepare pnpm@10 --activate"

case "$(uname -s)" in
  Darwin)
    xcode-select -p >/dev/null 2>&1 || die "Xcode command line tools missing. Run: xcode-select --install"
    ;;
  Linux)
    # Tauri links against the system webview at build time; without these the
    # failure is a pkg-config error deep in a build script, which reads as a
    # broken checkout rather than a missing package.
    missing=""
    if command -v pkg-config >/dev/null 2>&1; then
      for pkg in webkit2gtk-4.1 gtk+-3.0 librsvg-2.0; do
        pkg-config --exists "$pkg" || missing="$missing $pkg"
      done
    else
      missing=" pkg-config"
    fi
    [ -z "$missing" ] || die "missing system packages:$missing
  On Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev pkg-config"
    ;;
esac

# node_modules can lag the lockfile after a branch switch, and the resulting
# failure surfaces as a Vite resolve error rather than as itself.
echo "==> Installing dependencies"
pnpm install --frozen-lockfile

if command -v claude >/dev/null 2>&1; then
  echo "==> Claude Code: $(command -v claude)"
else
  echo "==> Claude Code not on PATH — the app also looks through your login shell,"
  echo "    so this is only a problem if the assistant panel says so too."
  echo "    Install: https://claude.com/claude-code"
fi

echo
echo "==> Starting the app (the first run compiles the Rust side and takes a while)"
echo "    Choose folder… opens a real vault. Cmd+J is the real CLI."
echo "    Edits to src/ hot-reload; edits to src-tauri/ rebuild and relaunch."
echo

# Drop a leading `--` so both `dev-app.sh --release` and `dev-app.sh -- --release`
# mean the same thing; npm eats one separator on the way in and it is not worth
# knowing which.
if [ "${1:-}" = "--" ]; then shift; fi

exec pnpm tauri dev "$@"
