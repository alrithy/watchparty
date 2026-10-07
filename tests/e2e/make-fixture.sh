#!/usr/bin/env bash
# Generates a small browser-playable test clip for the e2e suite (not committed).
set -euo pipefail
out="public/__test__/clip.webm"
[ -f "$out" ] && exit 0
mkdir -p public/__test__
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=320x180:rate=25 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 90 \
  -c:v libvpx -g 25 -b:v 300k -c:a libopus -shortest "$out"
