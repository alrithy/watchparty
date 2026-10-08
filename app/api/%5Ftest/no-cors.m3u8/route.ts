/**
 * TEMPORARY E2E TEST FIXTURE (PR #6 only).
 *
 * A cross-origin, intentionally CORS-inaccessible HLS master playlist pointing
 * to Apple's public BipBop HLS sample. No credentials, no video bytes relayed.
 *
 * Test from the PR's branch-alias origin, but paste the URL using a DISTINCT
 * immutable deployment host. In Safari, native <video> can play this playlist
 * without CORS; hls.js fetch() cannot read this cross-origin response.
 *
 * Remove this endpoint before merging PR #6 to main.
 */
const playlist = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-STREAM-INF:BANDWIDTH=1000000",
  "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/gear0/prog_index.m3u8",
  "",
].join("\n");

export function GET() {
  return new Response(playlist, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      // Intentionally NO Access-Control-Allow-Origin header.
    },
  });
}
