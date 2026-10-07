# OSS reuse audit (Milestone 3, 2026-10-07)

Reuse first: mature library, then small permissive code, then our own code only
for Watch Party glue (sync, rooms, Supabase). No GPL/AGPL code is copied.

| Feature | Candidate | License | Reuse method | Decision | Reason |
| --- | --- | --- | --- | --- | --- |
| Universal player | react-player 3.4.0 | MIT | npm | USE ITS ENGINES, not the component | ReactPlayer = these media elements + a URL-pattern picker + React wrapper. Its picker can't handle extensionless CDN links (an HLS/DASH link with no `.m3u8`/`.mpd` would get a plain `<video>`), so we create the same elements directly from our own detection. |
| HLS | hls-video-element 1.5.11 (→ hls.js 1.7.3) | MIT (Apache-2.0) | npm | USE | react-player's HLS engine; native HLS on Safari/iOS |
| DASH | dash-video-element 0.3.2 (→ dashjs 5.2.1) | MIT (BSD-3) | npm | USE | react-player's DASH engine |
| YouTube | youtube-video-element 1.9.0 | MIT | npm | USE | react-player's YouTube engine; HTMLMediaElement API over the official IFrame API |
| Vimeo | vimeo-video-element 1.7.3 | MIT | npm | REJECT (spike) | Swallows player errors (private/blocked videos never fail) and reports refused rate changes as applied, which breaks drift correction. Kept our thin wrapper over the official Vimeo Player SDK. |
| Adaptive streaming alternative | shaka-player 5.2.12 | Apache-2.0 | npm | REJECT | Would duplicate hls.js + dash.js, which the elements already bundle |
| URL detection | react-player patterns / own `resolveSource` | MIT | reference | KEEP OURS | Extension and YouTube/Vimeo matching mirrors react-player's patterns; the header probe for extensionless links has no library equivalent |
| SRT parsing | srt-parser-2 1.2.3 | MIT | npm | USE | Robust SRT parser; Arabic text verified |
| WebVTT parsing | browser `<track>` parser | built-in | native API | USE | Spec-complete, zero bytes; vtt.js (Apache-2.0) not needed |
| Subtitle rendering | native TextTrack display | built-in | native API | REJECT for display | Can't draw over YouTube/Vimeo iframes or apply a delay; a small overlay renders parsed cues instead |
| Reference watch party | howardchung/watchparty | MIT | ideas only | ADAPT IDEAS | Unified Player interface (ours already matches), SRT→VTT via `<track>`, subtitle offset syncing. No code copied. |
| Controls | native `<video>` / provider controls | built-in | native | USE | Host gets native controls (play/pause/seek/volume/fullscreen); no Video.js / Media Chrome needed for MVP |
| Torrents | webtorrent 3.0.21 | MIT | npm | POSTPONE | WebRTC-only peers in browsers; not on the paste-and-play path |
| Sync edge cases | howardchung/watchparty, kutsibalci/watch-party-sync-engine (MIT), Syncplay (Apache-2.0) | MIT / Apache-2.0 | ideas only | KEEP OURS | Existing host-authority + server clock + rate nudge + seek + reconnect already passes tests |
| Resolver v2 | Web-SyncPlay (MIT), yt-dlp | MIT / Unlicense | none | POSTPONE | No yt-dlp/proxy infrastructure in the 2-day MVP |

Licenses checked from npm metadata and each repo's LICENSE file on 2026-10-07.

## What stays custom

- `lib/player/media-element.ts`: one adapter mapping the media elements onto
  the sync engine's `PlayerAdapter` (errors from hls.js/dash.js, YouTube
  autoplay rejection, coarse-position smoothing, seek-only drift on YouTube).
- `lib/player/vimeo.ts`: thin wrapper over the official Vimeo Player SDK.
- `lib/media/source.ts`, `lib/media/probe.ts`: detection and the header-only
  probe for links with no extension.
- Sync engine, rooms, presence and Supabase transport (unchanged).
