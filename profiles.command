#!/bin/bash
# Double-click to take ONE reading and interpret it as six different people.
#
# Run this from Finder or Terminal, NOT from inside another app. macOS attributes
# a Bluetooth request to the "responsible" application for the process tree. From
# Terminal that is Terminal, and macOS simply asks your permission the first time.
set -euo pipefail
cd "$(dirname "$0")"
[ -x ./blehost ] || { echo "First run: building the Bluetooth host…"; ./setup-mac.sh; }

cat <<'INTRO'

  One measurement, six interpretations.

  The scale is told male / 39 / 180 cm during the handshake, because it needs
  an identity before it will run its impedance program. That identity does not
  reach the maths: the reading is latched, the link closes, and the same
  weight and impedance are then computed six times against six profiles.

  This is the point of the deferred design. Nobody stands on the scale six
  times; the radio work happens once.

  Press Enter, step on, and hold the handle until P-1 clears.

INTRO

exec node profiles.js "$@"
