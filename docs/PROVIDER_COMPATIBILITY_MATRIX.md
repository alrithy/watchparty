# Provider compatibility matrix

Evidence only. Rows say what was run and seen. Nothing here is a success
percentage.

**Environments**
- **Chrome/Linux (sandbox)**: Google Chrome 155.0.8059.39 on a Vercel Sandbox (iad1, open internet), driving a production build of PR A (`next start`, no Supabase, single tab). The check: paste the link, wait, play muted, read `videoWidth`/`videoHeight`/`readyState`, see `currentTime` advance over 2 s, seek to 30 s (or half the duration) and read the position again.
- **Discovery (sandbox Node 22)**: `discoverPage()` with the production pinned fetch, run against real sites, with metascraper 5.58.1 + metascraper-video 5.56.2 run on the same HTML for comparison.
- **Playwright Chromium (local E2E)**: generated fixtures. Two contexts: host and guest.
- **iPhone Safari / Home Screen app**: **not run yet.** That needs Hassan's device on the Preview.

Classification: PASS = picture decoded, time advanced and the seek landed. FAIL = the right source was found but did not play. UNSUPPORTED = we refuse honestly. REFUSED = the site rejected our server's check.

## Pasted web pages (2026-10-09)

| Page | Category | Public/signed | Found via → route | Chrome/Linux picture · time · seek | metascraper-video | Result |
| --- | --- | --- | --- | --- | --- | --- |
| archive.org/details/BigBuckBunny_124 | Open Graph video page | public | og:video → MP4, native `<video>` | 640×360 · +2.0 s · 33.9 s | same URL | **PASS** (resolved in 2.5 s) |
| en.wikipedia.org/wiki/Big_Buck_Bunny | `<video>` with renditions | public | `<video>`/`<source>` → 1080p WebM transcode, native | 1920×1080 · first 2 s still buffering (+0 s) · seek 30 s → 33.2 s 4 s later | 4K original | **PASS** on b78042f (before it, picked the 4000×2250 original) |
| commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm | MediaWiki file page | public | routed to discovery (d0bc80e) → 1080p WebM transcode, native | 1920×1080 · first 2 s still buffering (+0 s) · seek 30 s → 33.1 s 4 s later | 4K original | **PASS** on b78042f (before d0bc80e, taken as a direct file and failed with FINAL_CDN_CORS_BLOCKED) |
| ted.com/talks/sir_ken_robinson_do_schools_kill_creativity | JSON-LD VideoObject | public, signed query | JSON-LD contentUrl → HLS, hls.js | 640×480 · +2.0 s · 33.9 s | same URL | **PASS** |
| framatube.org/w/kkGMgK9ZtnKfYAgnEtQxbv (PeerTube) | JSON-LD VideoObject | public | JSON-LD → HLS, hls.js | 1920×1080 · +2.0 s · 33.8 s | same URL | **PASS** |
| mixkit.co/free-stock-video/waves-in-the-ocean-1164/ | JSON-LD VideoObject | public | JSON-LD → MP4, native | 720×1280 · +2.0 s · 14.1 s | same URL | **PASS** |
| streamable.com/moo | Open Graph video page | public (redirects to a signed CDN URL) | og:video → MP4, native | 853×480 · +2.0 s · 10.0 s | same URL | **PASS** (after ddbf09c; before it, wrongly refused as "provider") |
| example.com | page without video | public | — | — | none | UNSUPPORTED `PAGE_NOT_MEDIA` (correct) |
| nasa.gov/image-article/apollo-11-launch/ | page without a video file | public | — | — | none | UNSUPPORTED `PAGE_NOT_MEDIA` |
| bbc.com/news/videos | JS-rendered player | public | — | — | none | UNSUPPORTED `PAGE_NOT_MEDIA` (player is built by script; we don't run scripts) |
| apple.com/apple-events/ | JS-rendered player | public | — | — | none | UNSUPPORTED `PAGE_NOT_MEDIA` |
| test-videos.co.uk/bigbuckbunny/mp4-h264 | download listing | public | — | — | none | UNSUPPORTED `PAGE_NOT_MEDIA` (links, not a video element) |
| imgur.com/gallery/… | JS app | public | — | — | none | UNSUPPORTED `PAGE_NOT_MEDIA` |
| vimeo.com/channels/staffpicks, youtube.com/@NASA | channel pages | public | — | — | none | UNSUPPORTED `PAGE_NOT_MEDIA` (several videos, no single one) |
| w3schools.com/html/html5_video.asp | `<video>` page | public | — | — | none | REFUSED: 403 to our honest User-Agent, 200 to `node`. Not worked around |
| reddit.com, pexels.com, pixabay.com, bitmovin.com, download.blender.org | bot-protected | public | — | — | none | REFUSED (403 from a datacenter IP for every User-Agent we tried with curl) |
| dailymotion.com/video/…, player.twitch.tv | provider without our SDK adapter | public | named, no request | — | none | UNSUPPORTED `NO_EMBED_AVAILABLE` (PR B) |
| netflix.com/title/… | DRM service | — | named, no request | — | og:video **trailer** MP4 | UNSUPPORTED `DRM_LICENSE_REQUIRED` (deliberate: the trailer isn't the title) |

Comparison with metascraper: on every page where metascraper-video found a
video, discovery found the same URL. The exceptions are Streamable (fixed)
and Netflix (refused on purpose). Discovery also returns a candidate list, a
verification bit, a reason code, and the picker for multi-video pages.
metascraper returns only one URL or nothing. It also needs jsdom and the
native re2 module, so it stays rejected (see OSS_REUSE_AUDIT.md).

## Direct links (regression)

| Link | Category | Route | Chrome/Linux | Result |
| --- | --- | --- | --- | --- |
| archive.org/download/…/big_buck_bunny_720p_surround.mp4 | direct MP4 | fast path, native (no server request) | 640×360 · +2.0 s · 33.9 s | **PASS** |
| devstreaming-cdn.apple.com/…/img_bipbop_adv_example_fmp4/master.m3u8 | HLS with CORS | fast path, hls.js | 768×432 · +2.0 s · 33.8 s | **PASS** |
| github.com/ietf-wg-cellar/matroska-test-files/raw/master/test_files/test1.mkv | MKV through a redirect | fast path, Movi (+ redirect resolver) | canvas (Movi) · +2.06 s · 30.0 s | **PASS** |
| Local fixtures: WebM, MP4, HLS, DASH, extensionless, MKV H.264/AC-3, HEVC Main10/E-AC-3 extensionless, AVI, redirect chains, YouTube/Vimeo stand-ins | E2E suite | unchanged routes | Playwright Chromium, host + guest sync | 37 passed, 3 skipped (need Supabase or live hosts), 1 failed: "iPhone fullscreen keeps Arabic subtitles (video)". **Fails the same way on main** (2 of 4 runs on each); not caused by PR A |

Torrentio / Real-Debrid direct links: not re-run here (signed, account-bound
links that Hassan tests himself). The route is unchanged: known extensions
skip every server request, and extensionless ones use the same probe. The
probe now connects through the pinned fetch, with the same request headers
as before (`user-agent: node`, Range, no cookies).

## Page fixtures (local E2E, Playwright Chromium)

| Fixture | Expected | Result |
| --- | --- | --- |
| Open Graph page with a muted background loop | og:video plays; the loop is ignored; the signed query `?sig=a1&exp=9` is intact; guest follows play and seek (< 0.5 s) | PASS |
| JSON-LD `@graph` VideoObject → HLS | HLS player, title from the VideoObject | PASS |
| Two `<video>` elements | picker with 2 options; nothing plays before the host picks | PASS |
| og:video text/html YouTube embed | official YouTube player | PASS (with the IFrame API stand-in) |
| No video / Dailymotion link | specific message | PASS |

## iPhone acceptance (PR A gate, filled in from Hassan's device runs)

Each platform is recorded separately. Check: decoded picture, audible audio,
pause/resume, seek (3-5 s on Streamable, about 30 s elsewhere), a second device
following in the room, and reconnect. Failures carry the copied (sanitised)
diagnostics report.

| Link | iPhone Safari | Home Screen app | Notes |
| --- | --- | --- | --- |
| archive.org/details/BigBuckBunny_124 | not run | not run | |
| ted.com/talks/sir_ken_robinson_do_schools_kill_creativity | not run | not run | |
| streamable.com/moo | not run | not run | short clip: seek 3-5 s |
| one Torrentio/RD direct link (owner's own) | not run | not run | link itself not recorded |
| page-discovered video + Arabic SubDL/OpenSubtitles subtitle, iPhone fullscreen | not run | not run | a missing provider key is tracked separately, not as a discovery failure |

## Still to certify (needs a person or a device)

- iPhone Safari and the Home Screen app on the Preview: archive.org (MP4),
  TED (HLS on Safari's own player), Streamable, the JSON-LD fixture-like
  pages, plus one existing Torrentio/RD link and one direct HLS.
- Real YouTube/Vimeo found on a page (the sandbox IPs are blocked by both).
- Arabic subtitles on a page-discovered video: the search now uses the page
  title. The SubDL/OpenSubtitles keys are needed on the Preview.
