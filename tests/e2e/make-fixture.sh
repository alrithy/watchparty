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
# A sanitized episode file name for the live Find Arabic subtitles check (no real media).
[ -f "$dir/Silo S03E01.mp4" ] || cp "$dir/clip.mp4" "$dir/Silo S03E01.mp4"
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
# Containers and codecs <video> can't play, for the Movi fallback: MKV with H.264 + AC-3, an
# extensionless HEVC Main10 + E-AC-3 download, and an hour-long MKV for large seeks.
[ -f "$dir/clip.mkv" ] || ffmpeg "${q[@]}" "${src[@]}" -c:v libx264 -preset ultrafast -g 25 -pix_fmt yuv420p \
  -c:a ac3 -b:a 96k -shortest "$dir/clip.mkv"
[ -f "$dir/download-hevc" ] || ffmpeg "${q[@]}" "${src[@]}" -c:v libx265 -preset ultrafast -x265-params log-level=error \
  -g 25 -pix_fmt yuv420p10le -profile:v main10 -c:a eac3 -b:a 96k -shortest -f matroska "$dir/download-hevc"
[ -f "$dir/hevc.mp4" ] || ffmpeg "${q[@]}" -i "$dir/download-hevc" -c copy -tag:v hvc1 -movflags +faststart "$dir/hevc.mp4"
[ -f "$dir/long.mkv" ] || ffmpeg "${q[@]}" -f lavfi -i testsrc=size=160x90:rate=5 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 3600 -c:v libx264 -preset ultrafast -g 10 -c:a aac -b:a 32k -ac 1 -shortest "$dir/long.mkv"
# Cinematic 2.40:1 clips: catch the former double-16:9 boxing in immersive mode.
# Both are generated locally only; no real account, media or tokens needed.
[ -f "$dir/wide.mp4" ] || ffmpeg "${q[@]}" -f lavfi -i testsrc=size=480x200:rate=25 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 15 -c:v libvpx-vp9 \
  -deadline realtime -cpu-used 8 -b:v 300k -c:a libopus -b:a 64k -movflags +faststart \
  -shortest "$dir/wide.mp4"
[ -f "$dir/wide.mkv" ] || ffmpeg "${q[@]}" -f lavfi -i testsrc=size=480x200:rate=25 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 15 -c:v libx264 \
  -preset ultrafast -g 25 -pix_fmt yuv420p -c:a ac3 -b:a 96k -shortest "$dir/wide.mkv"
[ -f "$dir/clip.avi" ] || ffmpeg "${q[@]}" "${src[@]}" -c:v mpeg4 -c:a libmp3lame -shortest "$dir/clip.avi"
