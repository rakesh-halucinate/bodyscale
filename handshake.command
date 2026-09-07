#!/bin/bash
# Double-click to answer: does what we tell the scale change what it measures?
#
# Two readings, back to back. Both computed from the same real profile, so the
# only difference is the identity written during the handshake.
#
# Run this from Finder or Terminal, NOT from inside another app. macOS
# attributes a Bluetooth request to the "responsible" application for the
# process tree, and from Terminal that is Terminal.
set -euo pipefail
cd "$(dirname "$0")"
[ -x ./blehost ] || { echo "First run: building the Bluetooth host…"; ./setup-mac.sh; }
exec node handshake.js "$@"
