#!/usr/bin/env bash
#
# Sign a built Cerebro.app and wrap it in something installable.
#
# Split out of the build so CI and a local build produce the same artifact by
# the same steps. Signing happens here, before the disk image is assembled, so
# the copy a user drags to Applications is the signed one.
#
#   usage: scripts/mac-package.sh <path to Cerebro.app> [output name]
#
set -euo pipefail

APP="${1:?usage: scripts/mac-package.sh <path to Cerebro.app> [output name]}"
NAME="${2:-Cerebro}"
OUT_DIR="dist-mac"
DMG="$OUT_DIR/$NAME.dmg"
ZIP="$OUT_DIR/$NAME.zip"

if [ ! -d "$APP" ]; then
  echo "No app bundle at $APP — build it first (scripts/mac-build.sh)." >&2
  exit 1
fi

# Run a command with a deadline. macOS ships no timeout(1), and every step
# below talks to a system service that can wedge — hdiutil in particular is a
# known hang on CI runners, where a stuck packaging step held a machine for
# hours while the build it was packaging had finished in two minutes.
run_bounded() {
  local seconds="$1"
  shift
  "$@" &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$seconds" ]; then
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

# Ad-hoc signature ("-"). This is not notarization and does not satisfy
# Gatekeeper on a downloaded copy — that still needs the quarantine flag
# cleared. What it does buy: on Apple Silicon every binary must carry some
# valid signature to execute at all, and a bundle assembled by a build script
# can lose the linker's. Signing the whole bundle makes that deterministic.
#
# To ship a properly signed build instead, set MAC_SIGN_IDENTITY to a
# Developer ID Application identity from `security find-identity -v -p
# codesigning`, and notarize the DMG afterwards with `xcrun notarytool`.
IDENTITY="${MAC_SIGN_IDENTITY:--}"
echo "==> Signing $APP (identity: $IDENTITY)"
run_bounded 300 codesign --force --deep --sign "$IDENTITY" "$APP"
run_bounded 300 codesign --verify --deep --strict "$APP"

mkdir -p "$OUT_DIR"
rm -f "$DMG" "$ZIP"

# The zip is made first and unconditionally: `ditto` preserves the symlinks and
# the executable bit that a plain `zip` (and GitHub's own artifact packing)
# drop, and an app bundle missing either does not launch. It is the artifact
# that always exists.
echo "==> Building $ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

# The DMG is the nicer way to install — a window you drag from — so it is
# still attempted, but never at the cost of the whole build.
echo "==> Building $DMG"
STAGE="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGE"
  # A killed hdiutil can leave its scratch volume mounted.
  hdiutil detach "/Volumes/Cerebro" -force >/dev/null 2>&1 || true
}
trap cleanup EXIT
cp -R "$APP" "$STAGE/"
# The Applications symlink is what makes the mounted volume a drag-to-install
# window rather than a folder holding one file.
ln -s /Applications "$STAGE/Applications"

if run_bounded 300 hdiutil create \
  -volname Cerebro \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG" >/dev/null 2>&1; then
  echo "==> $DMG"
else
  echo "==> hdiutil did not finish; shipping $ZIP alone" >&2
  rm -f "$DMG"
fi

ls -lh "$OUT_DIR"
