#!/usr/bin/env bash
# Generates small browser-playable test media for the e2e suite (not committed):
# WebM, MP4, HLS (fMP4), DASH, and an extensionless "CDN download" copy.
# MP4-based fixtures use VP9/Opus because Playwright's Chromium ships without
# proprietary codecs (H.264/AAC); real browsers play H.264 the same way.
set -euo pipefail
dir="public/__test__"
mkdir -p "$dir"
src=(-f lavfi -i testsrc=size=320x180:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 90)
q=(-hide_banner -loglevel error -y)

[ -f "$dir/clip.webm" ] || ffmpeg "${q[@]}" "${src[@]}" -c:v libvpx -g 25 -b:v 300k -c:a libopus -shortest "$dir/clip.webm"
[ -f "$dir/clip.mp4" ] || ffmpeg "${q[@]}" "${src[@]}" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -g 25 \
  -b:v 300k -c:a libopus -b:a 64k -movflags +faststart -shortest "$dir/clip.mp4"
[ -f "$dir/download" ] || cp "$dir/clip.mp4" "$dir/download"
if [ ! -f "$dir/hls/index.m3u8" ]; then
  mkdir -p "$dir/hls"
  ffmpeg "${q[@]}" -i "$dir/clip.mp4" -c copy -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_segment_filename "$dir/hls/seg%03d.m4s" "$dir/hls/index.m3u8"
fi
if [ ! -f "$dir/dash/manifest.mpd" ]; then
  mkdir -p "$dir/dash"
  ffmpeg "${q[@]}" -i "$dir/clip.mp4" -c copy -f dash -seg_duration 4 -use_template 1 -use_timeline 0 \
    "$dir/dash/manifest.mpd"
fi
