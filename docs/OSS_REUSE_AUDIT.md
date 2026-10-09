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

## Auto Arabic subtitles (2026-10-07)

| Feature | Source | License | Reuse method | Decision |
| --- | --- | --- | --- | --- |
| Match weights, id-implies-title/year equivalences, equivalent release groups | Diaoul/subliminal `src/subliminal/score.py`, `src/subliminal/matches.py` | MIT | Adapted (ported to TypeScript in `lib/subtitles/search/score.ts`, copyright notice kept in the file header) | USE. Same weights (movie: title 162, year 54, release group 18, streaming service 18, fps 9, source 4, audio 2, resolution 1, video codec 1, exact release 323; episode: series 486, year 162, season 54, episode 54, …). "Country" dropped: release names don't carry it. |
| Release-name parsing (title, year, season/episode, group, source, resolution, codecs, service) | guessit-io/guessit | LGPL-3.0 | Reference only | NOT USED AS CODE. Python, LGPL. Field names and source grouping (WEB-DL / WEBRip / BluRay / HDTV / DVD) follow guessit. |
| Release-name parsing | parse-torrent-title 3.0.1 (npm) | MIT | npm dependency | USE. JS port of the guessit-style PTN parser; zero runtime deps. Spiked against @ctrl/video-filename-parser 5.12.0 (MIT): that one labelled unknown sources as WEB-DL and missed years in series names, so rejected. |
| Provider abstraction, matched/not-matched signals, HI and forced handling, minimum score before auto-download, upgrade to a better subtitle, provider failure isolation | morpheus65535/bazarr | GPL-3.0 | Ideas only | NO CODE COPIED. Taken as ideas: one small provider interface (search + download), each provider fails independently and the error is shown, hearing-impaired penalised unless asked for, nothing auto-applied below a confidence bar, reasons shown per result. Upgrade-later and forced-only postponed. |
| OpenSubtitles | OpenSubtitles REST API v1 | API terms | Direct `fetch` (≈150 lines) | USE. `opensubtitles-api` (MIT) on npm wraps the retired XML-RPC API, so not used. |
| SubDL | SubDL API v1 | API terms | Direct `fetch` | USE. Strong Arabic coverage; same interface as OpenSubtitles. |
| Zip extraction for SubDL downloads | fflate 0.8.3 (npm) | MIT | npm dependency | USE |
| Automatic subtitle timing (audio alignment) | smacke/ffsubsync | MIT | Future | POSTPONE. Preferred future source for auto-sync; needs ffmpeg/audio access we don't have in the browser-only MVP. Manual delay stays. |
| Automatic subtitle timing | kaegi/alass | GPL-3.0 | Ideas only | NO CODE COPIED. Noted only. |

Licenses checked from each repository's LICENSE file and npm metadata on 2026-10-07.

### Ranking we added on top of subliminal

- Wrong year (movie): minus twice the year weight, never auto-selected.
- Different season or episode: dropped.
- Not Arabic: minus half the maximum score. Hearing impaired when not asked for: minus 9. Machine translated: minus 18.
- Downloads, rating and trusted uploader only break ties (always worth under 1 point).
- **Confidence:** a result is applied automatically only when it matches the exact release name, the IMDb id, title + year (movie), or series + season + episode, in Arabic, without a year mismatch. Otherwise the host sees the top five with their reasons and picks.

## Advanced direct-media fallback (2026-10-07)

| Package | Version | License | Reuse method | Use |
| --- | --- | --- | --- | --- |
| movi-player | 0.4.1 | Apache-2.0 | npm dependency | advanced direct-media fallback |

- Used through its headless `movi-player/player` entry (`MoviPlayer`), lazy-loaded by
  `lib/player/movi.ts`. No Movi source is copied; its UI element, subtitle system and
  ambient mode are not used. Its `LICENSE` ships with the package (no NOTICE file).
- Spiked first (30 minutes) on generated MKV H.264/AAC, HEVC + AC-3, HEVC Main10 + E-AC-3,
  4K HEVC Main10, TrueHD, DTS, MPEG-TS, M2TS and AVI files, and a one-hour 706 MB MKV:
  all opened and seeked; the hour-long file read ~70 MB around each position, never the whole file.
- Considered only if Movi had failed the spike: brianhvo02/libmpv-wasm, MediaBunny.
  Raw ffmpeg.wasm transcoding of whole movies was ruled out.
- Links that block cross-origin Range reads: see "Redirect resolver and CORS Unlocker" below.

Checked from the package's LICENSE file and npm metadata on 2026-10-07.

## Redirect resolver and CORS Unlocker (2026-10-07)

| Project | License | Reuse method | Use |
| --- | --- | --- | --- |
| NuvioWebEnhanced | no clear license found | architecture/reference only | no copied code |

- The idea taken: resolve a debrid link's redirect chain on the server (headers only)
  and let the browser stream the final CDN URL, with an optional desktop extension
  that adds CORS headers when the CDN itself sends none. `lib/media/resolve-stream.ts`,
  `lib/media/refine.ts` and `extensions/cors-unlocker/` were written independently
  for this repo; no source, manifest or rule file was copied.
- No new dependencies. The extension uses only Chrome's built-in
  `declarativeNetRequest` API.

## Capability-aware routing (Milestone 4 Phase 1, 2026-10-08)

No new dependencies. Routing and diagnostics use browser APIs only:
`HTMLMediaElement.canPlayType`, `MediaSource` / `ManagedMediaSource`,
WebCodecs `VideoDecoder` / `AudioDecoder.isConfigSupported`, and
`navigator.mediaCapabilities.decodingInfo`. Facts taken from the installed
packages' own source (not copied):

| Package | Version | License | Fact used |
| --- | --- | --- | --- |
| hls-video-element | 1.5.11 | MIT | Uses hls.js whenever `Hls.isSupported()`; native HLS only otherwise |
| hls.js | 1.7.3 | Apache-2.0 | Prefers `ManagedMediaSource` (iOS 17.1+) and disables remote playback for it |
| dashjs | 5.2.1 | BSD-3-Clause | Creates a `ManagedMediaSource` when present |
| movi-player | 0.4.1 | Apache-2.0 | `getMediaInfo()` for diagnostics; WASM audio fallback when `AudioDecoder` is missing |

So Safari (macOS, iOS, Home Screen web apps) now gets a plain `<video>` for
HLS first, with hls.js as the fallback. See `docs/M4_PLAYBACK_AUDIT.md`.

## Universal Link Playback, PR A (2026-10-09)

Versions and licenses from npm metadata and each repository's README/LICENSE on 2026-10-09.

| Candidate | Version / license | Decision | Evidence |
| --- | --- | --- | --- |
| htmlparser2 | 12.0.0, MIT | **USE** (server only) | Streaming tokenizer, no DOM, no script execution; deps entities/domhandler/domutils/domelementtype (~1.1 MB on disk, 0 bytes in the browser bundle). Handles malformed markup (test: "survives malformed HTML"). Already the parser under cheerio and metascraper. |
| ipaddr.js | 2.5.0, MIT | **USE** (server only) | Range table for IPv4/IPv6 incl. IPv4-mapped, NAT64, 6to4, Teredo; 0 deps, 84 KB. Replaces our hand-written check, which missed `::ffff:7f00:1`. Same library express's proxy-addr uses. |
| microlinkhq/metascraper (+ metascraper-video) | 5.58.1 / 5.56.2, MIT | **ADAPT rules, REJECT dependency** | Takes `{html, url}` (compatible with our guarded fetch), but `@metascraper/helpers` pulls jsdom 30 and **re2 (native addon)**, lodash, chrono-node etc.: tens of MB server-side and a native build on Vercel. metascraper-video returns one winning URL with no candidate list, no confidence, no verification, so it can't drive "pick when unsure". Its field order (og:video:secure_url → og:video:url → og:video → twitter:player:stream → JSON-LD contentUrl → `<video src>`) is mirrored in `extract.ts`; no code copied. |
| itteco/iframely | 2.5.0, MIT | **REJECT dependency, ADAPT ideas** | A self-hosted Express gateway (redis/memcached, got, cheerio 0.22, express 4, ~28 direct deps) with its own fetcher, so our SSRF pinning wouldn't cover it; returns provider embed HTML we must not execute. Ideas taken: domain-specific provider list ahead of generic metadata, oEmbed discovery as a separate step. |
| oEmbed spec (oembed.com) | spec | **USE (restricted)** | Discovery `<link rel="alternate" type="application/json+oembed">` followed only to official endpoints of listed providers; `html` never rendered, only an iframe `src` mapped to an SDK we drive. Arbitrary sites' endpoints (e.g. WordPress `/wp-json/oembed`) return blockquotes/iframes we can't sync, so they aren't fetched. |
| oembed-providers | 1.0.20260604, MIT | **OPTIONAL (PR B)** | The oembed.com registry as data. Not needed while only YouTube/Vimeo are playable; useful when PR B adds providers. |
| Open Graph (ogp.me), schema.org VideoObject, Twitter player card | specs | **USE** | Implemented in `extract.ts` (structured `og:video:*` groups, JSON-LD `@graph`/nested `video`, `contentUrl`/`embedUrl`/`duration`/`encodingFormat`). |
| yt-dlp | Unlicense (source); PyInstaller release binaries GPLv3+ (README: "the combined work is licensed under GPLv3+") | **OPTIONAL, PR D only** | Python, not a player, no browser output guarantee; would need an isolated worker outside Vercel. Not added until real links that A–C can't play are shown to play from its metadata. |
| streamlink | BSD-2-Clause | **OPTIONAL, later** | Designed to pipe live streams into a local player (VLC); useful only as a live-stream URL resolver in a worker. |
| imputnet/cobalt | AGPL-3.0 (repo default) | **REJECT (reference only)** | Downloader that "works like a fancy proxy": conflicts with the no-byte-proxy rule; AGPL. Not read for code. |
| bluenviron/mediamtx | MIT | **REJECT for now** | Separate media server; only if self-hosted restreaming were ever needed. |
| cookpete/react-player | 3.4.0, MIT | **KEEP current use** (its media elements, not the component) | Unchanged from M3: its URL picker can't classify extensionless or page URLs. |
| shaka-project/shaka-player | 5.2.12, Apache-2.0 | **REJECT** | Would duplicate hls.js 1.7.3 + dash.js 5.2.1 already in use. Reconsider only for DRM-free DASH edge cases hls/dash.js fail on (none observed). |
| videojs/video.js | 8.24.1, Apache-2.0 | **REJECT** | UI framework over the same engines; our immersive controls already cover iPhone. |
| MrUjjwalG/movi-player | 0.4.1, Apache-2.0 | **KEEP** | Unchanged MKV/HEVC fallback. |
| YouTube IFrame API / Vimeo Player SDK (@vimeo/player 2.30.4, MIT) | official | **KEEP** | Embeds found on pages map onto the existing adapters; no custom extraction from either service. |
| Dailymotion Player, Twitch Embed, Wistia player (@wistia/wistia-player 0.7.24, MIT), Streamable | official SDKs | **PR B to evaluate** | Recognised and named in errors now; each must prove play/pause/seek/position control before it is listed as playable. |

Added to the browser bundle by PR A: `lib/media/discover/providers.ts` +
types + the picker (a few KB of our own code). htmlparser2 and ipaddr.js run
only in route handlers.
