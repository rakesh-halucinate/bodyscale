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

  Do this exactly, because contact is what we are testing:

    1. Bare feet. No socks.
    2. If your soles are dry, dampen them slightly. Dry skin reads as a
       near-open circuit, which is what a 1900 ohm reading looks like.
    3. Stand still with BOTH feet flat, each foot touching BOTH metal pads.
    4. Stay on until it finishes.

  AT THE SAME TIME, note what the scale's OWN display shows: the weight, and
  the body fat percentage if it gives one. That is the comparison that settles
  this. If the scale shows a sensible body fat and we do not, the fault is
  ours. If the scale also refuses or shows nothing, the contact is the fault.

INTRO

echo "  Saving frames to: $OUT"
echo
node scale.js --raw 2>&1 | tee "$OUT"
echo
echo "  Saved to $OUT — send me that file, plus what the scale's display said."
