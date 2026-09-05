#!/bin/bash
# Double-click to rehearse the Electron flow with the real scale.
#
# Run this from Finder or Terminal, NOT from inside another app. macOS attributes
# a Bluetooth request to the "responsible" application for the process tree. From
# Terminal that is Terminal, and macOS simply asks your permission the first time.
# Launched from inside some other app, the request is attributed to that app, and
# if it has no Bluetooth entitlement macOS kills the process outright.
set -euo pipefail
cd "$(dirname "$0")"
[ -x ./blehost ] || { echo "First run: building the Bluetooth host…"; ./setup-mac.sh; }

cat <<'INTRO'

  This is the flow the Windows app will use:

      IDLE  --"Measure Me"-->  CAPTURING  --reading-->  HELD  --details-->  RESULT

  Press Enter to start a capture, then step on the scale.

  Once the reading lands it is HELD. The scale link closes immediately, so you
  can step off and on as much as you like and nothing is re-read. Take your
  time entering your details; there is no deadline.

  If nothing arrives within a few seconds you will be told what to do about it.
  If macOS asks for Bluetooth permission, click Allow.

INTRO

# The scan window is generous: the first run may spend time waiting for the
# Bluetooth prompt, and the scale's radio sleeps when it is idle.
exec node simulate.js "$@"
