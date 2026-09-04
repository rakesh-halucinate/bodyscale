#!/bin/bash
# Build the Bluetooth host bundle.
#
# macOS refuses Bluetooth to a process whose bundle does not declare
# NSBluetoothAlwaysUsageDescription, and it refuses by killing it outright
# (Termination Reason: Namespace TCC) rather than returning an error. Apple's
# command-line Python lives inside a Python.app whose Info.plist has no such
# key, so any bleak script run with it dies instantly.
#
# The fix is to run Python from a bundle we control that does declare the key.
# This script builds that bundle around the project's virtualenv interpreter.
set -euo pipefail
cd "$(dirname "$0")"

VENV=.venv
APP=blehost.app
PY311=/usr/local/bin/python3.11

if [ ! -x "$VENV/bin/python" ]; then
  echo "Creating the virtualenv…"
  if [ -x "$PY311" ]; then "$PY311" -m venv "$VENV"; else python3 -m venv "$VENV"; fi
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet bleak
fi

BASE="$("$VENV/bin/python" -c 'import sys;print(sys.base_prefix)')"
SITE="$("$VENV/bin/python" -c 'import site;print(site.getsitepackages()[0])')"

# A framework Python ships a stub in bin/ that re-executes the real interpreter
# inside Resources/Python.app. Copying the stub is useless: the process ends up
# running from Apple's or Homebrew's bundle, whose Info.plist has no Bluetooth
# key, and macOS kills it. Copy the real interpreter so OUR Info.plist is the
# one that applies.
REAL_PY="$BASE/Resources/Python.app/Contents/MacOS/Python"
if [ ! -x "$REAL_PY" ]; then
  REAL_PY="$("$VENV/bin/python" -c 'import sys,os;print(os.path.realpath(sys.base_prefix + "/bin/python" + sys.version[:4]))')"
fi
[ -x "$REAL_PY" ] || REAL_PY="$("$VENV/bin/python" -c 'import sys,os;print(os.path.realpath(sys.executable))')"

echo "Interpreter: $REAL_PY"

# macOS kills any process that touches CoreBluetooth from a bundle whose
# Info.plist lacks a Bluetooth usage description, and it kills rather than
# returning an error. A framework Python's own bundle has no such key, so add
# it. Idempotent, and re-applied after a brew upgrade replaces the bundle.
FW_APP="$BASE/Resources/Python.app"
if [ -d "$FW_APP" ]; then
  if ! /usr/libexec/PlistBuddy -c "Print :NSBluetoothAlwaysUsageDescription" "$FW_APP/Contents/Info.plist" >/dev/null 2>&1; then
    echo "Adding the Bluetooth usage description to $FW_APP"
    /usr/libexec/PlistBuddy -c "Add :NSBluetoothAlwaysUsageDescription string 'Reads weight and impedance from your Bluetooth body scale.'" "$FW_APP/Contents/Info.plist" >/dev/null 2>&1 || true
    /usr/libexec/PlistBuddy -c "Add :NSBluetoothPeripheralUsageDescription string 'Reads weight and impedance from your Bluetooth body scale.'" "$FW_APP/Contents/Info.plist" >/dev/null 2>&1 || true
    codesign --force --sign - "$FW_APP" >/dev/null 2>&1 || true
  fi
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$REAL_PY" "$APP/Contents/MacOS/blehost"
chmod +x "$APP/Contents/MacOS/blehost"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Scale BLE Host</string>
  <key>CFBundleDisplayName</key><string>Scale BLE Host</string>
  <key>CFBundleIdentifier</key><string>local.bodyscale.blehost</string>
  <key>CFBundleExecutable</key><string>blehost</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSBackgroundOnly</key><true/>
  <key>NSBluetoothAlwaysUsageDescription</key>
  <string>Reads weight and impedance from your Bluetooth body scale.</string>
  <key>NSBluetoothPeripheralUsageDescription</key>
  <string>Reads weight and impedance from your Bluetooth body scale.</string>
</dict>
</plist>
PLIST

# Ad-hoc sign so macOS treats the bundle as a stable identity for the
# permission grant, rather than re-prompting on every launch.
codesign --force --sign - --identifier local.bodyscale.blehost "$APP" 2>/dev/null \
  && echo "Signed the bundle (ad-hoc)." || echo "codesign unavailable; continuing unsigned."

# A launcher, so nothing downstream has to know about PYTHONHOME quoting. The
# project path can contain spaces, so everything here stays quoted.
cat > blehost <<'LAUNCH'
#!/bin/bash
# Runs Python from the bundle that declares the Bluetooth usage description.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PYTHONHOME="__BASE__"
export PYTHONPATH="__SITE__"
export PYTHONDONTWRITEBYTECODE=1
exec "$HERE/blehost.app/Contents/MacOS/blehost" "$@"
LAUNCH
/usr/bin/sed -i '' "s|__BASE__|$BASE|; s|__SITE__|$SITE|" blehost
chmod +x blehost
rm -f .blehost-env

echo "Built $APP and the blehost launcher"
if ./blehost -c "import sys, bleak; print('bundle runs Python', sys.version.split()[0], 'with bleak')"; then
  echo "Bundle is working."
else
  echo "Bundle could not start Python; see the error above."
  exit 1
fi
