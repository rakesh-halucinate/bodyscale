#!/bin/bash
# Double-click to take a measurement.
#
# Run this from Finder or Terminal, NOT from inside another app. macOS attributes
# a Bluetooth request to the "responsible" application for the process tree. From
# Terminal that is Terminal, and macOS simply asks your permission the first time.
# Launched from inside some other app, the request is attributed to that app, and
# if it has no Bluetooth entitlement macOS kills the process outright.
set -euo pipefail
cd "$(dirname "$0")"
[ -x ./blehost ] || { echo "First run: building the Bluetooth host…"; ./setup-mac.sh; }
echo
echo "Loop mode: step on for a reading, step off, step on again for the next."
echo "Press Ctrl+C when you are done."
echo "If macOS asks for Bluetooth permission, click Allow."
echo

# Generous windows on purpose: the first run may spend time waiting for you to
# accept the Bluetooth prompt, and the scale's radio sleeps when it is idle.
# Loop by default so you can weigh yourself repeatedly without restarting.
# Step on for a reading, step off, step on again for the next one.
if [ $# -gt 0 ]; then
  exec node scale.js "$@"
else
  exec node scale.js --watch --scan-timeout 90 --hold 180 --interval 3
fi
