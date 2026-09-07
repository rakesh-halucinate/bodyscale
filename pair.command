#!/bin/bash
# Double-click to find the scale and remember it.
#
# Run this from Finder or Terminal, NOT from inside another app. macOS
# attributes a Bluetooth request to the "responsible" application for the
# process tree; launched from somewhere without the entitlement, the OS kills
# the process outright rather than refusing the request.
set -euo pipefail
cd "$(dirname "$0")"
[ -x ./blehost ] || { echo "First run: building the Bluetooth host…"; ./setup-mac.sh; }

cat <<'INTRO'

  Pairing — find the scale and remember it.

  This is what the Electron admin screen will do: scan, show what is nearby,
  and save the one you pick. Nothing is connected to and nothing is written to
  any device.

  The scale's radio sleeps when idle and advertises in short bursts on waking,
  so TAP THE PLATE just before the scan starts or it will not appear.

INTRO

exec node pair.js "$@"
