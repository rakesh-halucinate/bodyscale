#!/bin/bash
# Double-click to capture the raw Bluetooth frames.
#
# This does not interpret anything. It records exactly what the scale sends, so
# the impedance can be checked against the bytes rather than argued about.
set -euo pipefail
cd "$(dirname "$0")"
[ -x ./blehost ] || { echo "First run: building the Bluetooth host…"; ./setup-mac.sh; }

OUT="frames-$(date +%H%M%S).txt"
cat <<'INTRO'

  RAW FRAME CAPTURE

  THE ORDER MATTERS THIS TIME.

    1. Step on FIRST and let the weight settle before anything else.
    2. Bare feet, both flat, each foot touching BOTH metal pads.
    3. Then STAND STILL and wait. The display will show P-1 and hold for
       about ten seconds while the scale measures impedance.
    4. Do not step off until the terminal says it has captured.

  You will probably see this, and it is the tool working, not failing:

      impedance NNNN is outside the physical band; the scale's own program
      has not finished. Stand still - waiting for the real reading.

  That is the placeholder the scale sends the moment weight settles. The real
  reading comes after P-1 finishes.

  Note what the scale's OWN display shows as it cycles: weight, body fat,
  BMI, muscle.

INTRO

echo "  Saving frames to: $OUT"
echo
node scale.js --raw 2>&1 | tee "$OUT"
echo
echo "  Saved to $OUT — send me that file, plus what the scale's display said."
