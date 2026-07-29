#!/usr/bin/env bash
#
# Sign a built Cerebro.app and wrap it in a drag-to-install DMG.
#
# Split out of the build so CI and a local build produce the same artifact by
# the same steps. Signing happens here, before the DMG is assembled, so the
# copy a user drags to Applications is the signed one.
#
#   usage: scripts/mac-package.sh <path to Cerebro.app>
#
set -euo pipefail

APP="${1:?usage: scripts/mac-package.sh <path to Cerebro.app>}"
OUT_DIR="dist-mac"
DMG="$OUT_DIR/Cerebro.dmg"

if [ ! -d "$APP" ]; then
  echo "No app bundle at $APP — build it first (scripts/mac-build.sh)." >&2
  exit 1
fi

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
codesign --force --deep --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"

echo "==> Building $DMG"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
# The Applications symlink is what makes the mounted volume a drag-to-install
# window rather than a folder holding one file.
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname Cerebro \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG" >/dev/null

echo "==> $DMG"
