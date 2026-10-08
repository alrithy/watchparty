# Milestone 4 playback audit (Issue #5)

Baseline: `main` at `c1db769` (Milestone 3 merged). Written 2026-10-08.
Scope: maximum reliable playback of legitimate, reachable media links, with
iPhone Safari and the installed Home Screen Web App first. No DRM bypass, no
Vercel video-byte proxy, no rewrite of the existing engines.

Every claim below is marked with where it comes from:
**[code]** read in this repo, **[pkg]** read in the installed package source,
**[doc]** official documentation, **[web]** secondary source, **[unverified]**
inferred and still needing a real-device or real-account test.

---

## 1. Summary

1. **Biggest iPhone win without new infrastructure: let Safari play HLS
   natively.** `hls-video-element` uses hls.js whenever `Hls.isSupported()`
   is true [pkg: `hls-video-element/dist/hls-video-element.js` `load()`], and
   hls.js 1.7.3 counts iOS 17.1+ `ManagedMediaSource` as supported
   [pkg: `hls.js/dist/hls.mjs` `getMediaSource()` prefers `ManagedMediaSource`].
   So today an iPhone plays every `.m3u8` through hls.js on Managed Media
   Source, not through Safari's own HLS player. That path needs CORS on every
   playlist and segment, turns AirPlay off (hls.js sets
   `disableRemotePlayback` for MMS) and can't use Dolby/HEVC paths that only
   native HLS has. Apple's guidance is native HLS on Safari [doc]. Phase 1
   (this PR) routes HLS to the native `<video>` on WebKit, with hls.js as the
   one fallback.
2. **Provider-side transcoding is the only realistic iPhone path for MKV,
   AVI, DTS/TrueHD and other non-native files whose CDN sends no CORS.**
   Movi (the only engine that can decode those in a browser) needs CORS +
   Range on the media host [code: `lib/player/movi.ts`, `lib/media/refine.ts`],
   and Hassan confirmed real RD/Nuvio links fail exactly that way (M3). A
   phone can't install the CORS Unlocker. Real-Debrid documents
   `GET /streaming/transcode/{id}` returning `apple` (M3U8), `dash`,
   `liveMP4` and `h264WebM` links [doc: api.real-debrid.com]. An `apple` HLS
   link played by native Safari HLS needs no CORS at all, so Phase 1 is also
   the prerequisite for Phase C.
3. **Today's routing is extension-first and error-driven** [code:
   `lib/media/source.ts:85`, `lib/player/create.ts:17`]. It can't see the
   device: it loads the 15 MB Movi chunk on browsers that have no
   `VideoDecoder`, sends DASH to browsers with no MSE, and reports most
   failures as "not browser compatible" without saying which part failed.
   Phase 1 adds a per-device capability snapshot, a routing plan with
   reasons, an error code per failure, and a diagnostics panel.
4. **No success percentage is claimed.** Gains below are per matrix cell
   (FAIL → expected PASS), and every iPhone cell stays "expected" until
   Hassan's real-device run records PASSED / FAILED /
   UNSUPPORTED_BY_PROVIDER / DRM_AUTH_REQUIRED.

---

## 2. Inventory of the current code (`c1db769`)

| Piece | File | What it does today |
| --- | --- | --- |
| Source detection | `lib/media/source.ts` | URL extension → `file` / `hls` / `dash`; YouTube/Vimeo ids; `prefersMovi()` for `.mkv .avi .ts .m2ts .mts .wmv .flv` (path or probed file name) |
| Header probe | `lib/media/probe.ts`, `app/api/probe/route.ts` | Extensionless links only: HEAD, then 2 KB ranged GET; content-type / disposition / `#EXTM3U` / `<MPD` sniff. SSRF guard per hop (`assertPublic`) |
| Redirect resolver | `lib/media/resolve-stream.ts`, `app/api/media/resolve/route.ts` | Follows redirects (headers only, `Range: bytes=0-0`), reports final URL, 206/200, ACAO |
| Refinement | `lib/media/refine.ts` | After Movi's RANGE_BLOCKED: resolve on server, check CORS from the page, retry Movi once on the final URL, else FINAL_CDN_CORS_BLOCKED |
| Engine choice | `lib/player/create.ts` | Vimeo → SDK wrapper; `file` → `FallbackPlayer` (native↔Movi); `hls`/`dash`/`youtube` → `MediaElementAdapter` with `hls-video` / `dash-video` / `youtube-video` |
| Native/HLS/DASH/YT adapter | `lib/player/media-element.ts` | Maps element + hls.js/dash.js errors to messages; "no video track" check for files; 20 s ready timeout for iframes |
| Movi adapter | `lib/player/movi.ts` | Headless `MoviPlayer`, canvas renderer, 128 MB cache, logger SILENT, linear mode = fail |
| Fallback | `lib/player/fallback.ts` | One local switch between native and Movi; position / play / volume / mute carried; room revision untouched |
| Dormant RD | `lib/realdebrid/*`, `app/api/resolve/route.ts` | Host-token `/unrestrict/link`; not in the UI (M3 decision) |

Engine versions [pkg, `package-lock.json`]: hls-video-element 1.5.11 →
hls.js 1.7.3 (Apache-2.0), dash-video-element 0.3.2 → dashjs 5.2.1
(BSD-3-Clause), youtube-video-element 1.9.0 (MIT), movi-player 0.4.1
(Apache-2.0).

---

## 3. Facts the plan depends on

| Fact | Source | Consequence |
| --- | --- | --- |
| hls.js 1.7.3 uses `ManagedMediaSource` when present; `isSupported()` true on iOS 17.1+ | [pkg] `hls.mjs` `getMediaSource()`, `isSupported()` | iPhone HLS currently goes through hls.js, not native |
| hls.js sets `disableRemotePlayback` for MMS | [pkg] `hls.mjs` (`ManagedMediaSource will not open without disableRemotePlayback…`) | AirPlay is off for HLS today on iPhone |
| hls-video-element only falls back to native HLS when hls.js is unsupported | [pkg] `hls-video-element.js` `load()` | Needs routing outside the element |
| dash.js 5.2.1 also uses `ManagedMediaSource` | [pkg] `dash.all.debug.js` (`Created ManagedMediaSource`) | DASH can work on iOS 17.1+, never earlier; Safari has no native DASH |
| MMS on iPhone since iOS 17.1 | [web] Radiant Media Player, Shaka README | DASH/hls.js need iOS ≥ 17.1 |
| Native HLS in Safari needs no CORS (media element loads, not `fetch`) | [doc] HTML media element fetch mode is no-cors without `crossorigin` | Non-CORS HLS (e.g. provider transcodes) plays natively but not in hls.js |
| WebCodecs `VideoDecoder` on iOS Safari since 17.4 (Movi notes) / 16.4 (reports) | [pkg] `movi-player/AGENTS.md` §9; [web] | Movi on iPhone needs ≥ 17.4 in practice |
| `AudioDecoder` on iOS Safari only from iOS 26 | [web] MDN mirror, Softvelum | Before 26, Movi decodes all audio in WASM (`SoftwareAudioDecoder`) — works, costs CPU |
| Movi falls back to its WASM audio decoder when `AudioDecoder` is missing or refuses a codec | [pkg] `movi-player/dist/decode/AudioDecoder.js` (`isConfigSupported` in try → `initSoftwareDecoder`) | AC-3/E-AC-3/DTS/TrueHD audio possible on iPhone via Movi |
| Movi caps 4K+ to 1.5× rate, small mobile frame queue; AV1 software-only on most iPhones | [pkg] `AGENTS.md` §7.1, §7.2, §9 | Drift nudges (±5 %) fine; 4K AV1 on iPhone not realistic |
| Movi exposes `MoviPlayer.assessPlayback()` (playable / smooth / powerEfficient / decoder) and `getMediaInfo()` | [pkg] `dist/core/MoviPlayer.d.ts`, `dist/types.d.ts` | Diagnostics can reuse them instead of our own probing |
| Web Audio on iPhone is muted by the silent switch unless `navigator.audioSession.type = "playback"` (iOS 17+) | [web] WebKit bugs 237322, 261554 | Movi (Web Audio output) can be silent on iPhone while `<video>` is not → Phase B fix |
| iOS Home Screen web apps have no element fullscreen API | PR #4 work, [pkg] Movi AGENTS §9 ("no programmatic fullscreen") | Immersive fullscreen (PR #4) stays independent |
| RD `GET /streaming/transcode/{id}` → `{apple, dash, liveMP4, h264WebM}` quality maps; `GET /streaming/mediaInfos/{id}` → duration, size, video/audio/subtitle details; `POST /unrestrict/link` has `remote=1` ("Remote traffic, dedicated servers and account sharing protections lifted"); `{id}` comes from `/downloads` or `/unrestrict/link` | [doc] api.real-debrid.com | Provider HLS for iPhone is documented; requires an RD token server-side |
| RD error 22 "IP Address not allowed", 23 "Traffic exhausted", 34 "Too many requests", 36 "Fair Usage Limit", 37 "Disabled endpoint" | [doc] | Explicit error mapping (already in `lib/realdebrid/types.ts`) |

Still **[unverified]** (needs a real RD account; nothing here is built on it yet):
whether the `/d/<ID>/` segment of an RD download link equals the
`/unrestrict/link` `id`; whether transcode links send CORS; whether they are
bound to the requesting IP or work for a guest elsewhere; whether the `apple`
playlist is VOD (seekable, finite duration) or live/event; whether its
timeline starts at 0 and matches the original file's duration; transcode
start latency; quota counted per viewer.

---

## 4. Capability matrix

Legend: ✅ plays today (verified on that platform in M2/M3), 🟡 expected but
not yet device-verified, ❌ fails, ➜ expected after the named phase.
"CORS" means the media host sends `Access-Control-Allow-Origin` for this
site. iPhone = Safari on iOS 17.4+; HSWA = installed Home Screen Web App
(same engine as Safari; no element fullscreen).

| Source | iPhone Safari / HSWA today | After Phase 1 (this PR) | After B / C | Desktop Chrome/Edge today | Desktop Safari today |
| --- | --- | --- | --- | --- | --- |
| MP4/MOV H.264 + AAC | ✅ native (Silo S03E01 RD MP4 passed) | unchanged | – | ✅ native | 🟡 native |
| MP4 HEVC 8/10-bit | 🟡 native (hardware) | unchanged; diagnostics show codec/size | – | 🟡 native if HEVC hw, else Movi via "no video track" | 🟡 native |
| MP4 with AC-3 / E-AC-3 audio | 🟡 native (Apple decodes Dolby) | unchanged | B: detect silent audio | ❌ silent on native (no error) | 🟡 native |
| MKV / AVI / TS / M2TS, CDN **with** CORS+Range | 🟡 Movi (iOS ≥ 17.4) | unchanged; Movi skipped on devices without `VideoDecoder` (clear error instead of a 15 MB download) | B: audioSession fix for silent switch | ✅ Movi | 🟡 Movi |
| MKV / AVI / TS, redirect hop without CORS, final CDN with CORS | 🟡 Movi after resolver | unchanged | – | ✅ Movi after resolver | 🟡 |
| MKV etc., final CDN **without** CORS (typical RD) | ❌ FINAL_CDN_CORS_BLOCKED | ❌ same, now with error code + diagnostics | ➜ C: RD `apple` HLS via native HLS (needs host RD token) | ✅ with CORS Unlocker extension, else ❌ | ❌ |
| DTS / TrueHD audio in MKV, CORS OK | 🟡 Movi WASM audio | unchanged | – | ✅ Movi | 🟡 |
| HLS (`.m3u8`) **with** CORS | 🟡 hls.js on MMS (AirPlay off) | ➜ native Safari HLS (AirPlay, Dolby, lower power), hls.js as fallback | – | ✅ hls.js | 🟡 hls.js on MSE → ➜ native |
| HLS **without** CORS | ❌ hls.js network error | ➜ native Safari HLS needs no CORS | – | ❌ hls.js (no native HLS in Chrome desktop) | ❌ → ➜ native |
| HLS with HEVC / Dolby audio renditions | 🟡 depends on MMS codec support | ➜ native (Apple's own HLS stack) | – | 🟡 | ➜ native |
| DASH (`.mpd`) with CORS | 🟡 dash.js on MMS (iOS ≥ 17.1) | unchanged on ≥ 17.1; explicit "needs iOS 17.1+" error below that | – | ✅ dash.js | 🟡 dash.js |
| WebM VP9 | 🟡 native on most iPhones | unchanged | – | ✅ | 🟡 |
| WebM / MP4 AV1 | ❌ unless iPhone 15 Pro+ hardware | unchanged; diagnostics show decoder support | – | ✅ (hw or dav1d) | 🟡 M3+ Macs |
| Extensionless CDN link | ✅ via probe (file name / content type) | ➜ also routes by `Content-Type` (e.g. `video/x-matroska` → Movi first) | – | ✅ | ✅ |
| 401/403/404/410, expired signed link | ✅ message | ➜ code EXPIRED_OR_UNAUTHORIZED | C: re-unrestrict via RD | ✅ | ✅ |
| DRM (EME) | ❌ by design | ➜ code DRM_LICENSE_REQUIRED with its own message | never | ❌ by design | ❌ by design |
| HTML page instead of media | ✅ "can't be played directly" | ➜ code NOT_MEDIA | – | ✅ | ✅ |
| YouTube / Vimeo | 🟡 iframe providers | unchanged | – | ✅ | ✅ |

---

## 5. Gap analysis

| # | Gap | Evidence | Impact | Phase |
| --- | --- | --- | --- | --- |
| G1 | iPhone/Safari HLS forced through hls.js + MMS | §3 rows 1–3 | Non-CORS HLS fails; AirPlay off; extra CPU; misses native HEVC/Dolby | **1** |
| G2 | Routing ignores device capabilities | `create.ts:17` uses only the extension | Movi chunk loaded where it can't run; DASH tried without MSE | **1** |
| G3 | Failures have messages but no codes or attempt record | `fallback.ts`, `media-element.ts` emit strings | Real-iPhone reports can't say which engine/step failed | **1** |
| G4 | `Content-Type` from the probe isn't used for engine choice | `prepare.ts` keeps only `kind` + file name | Extensionless MKV without a disposition name starts on native, may play silently | **1** |
| G5 | DRM shown as "can't be played directly" | `media-element.ts:145,223,230` | Viewer can't tell DRM from a page link | **1** |
| G6 | Silent audio / black video not detected on native (AC-3 in Chrome, HEVC without hw) | only `videoWidth === 0` check (`media-element.ts:201`) | False success | B |
| G7 | Movi audio muted by iPhone silent switch | §3 audioSession row | Silent playback on iPhone | B |
| G8 | No audio-track choice on fallback (multi-audio MKV/HLS) | adapters expose none | Wrong-language or undecodable default track | B |
| G9 | Server probe/resolver re-resolve DNS at connect time (DNS-rebinding window) | `probe.ts:84-98` checks `lookup()`, then `fetch` resolves again | SSRF hardening incomplete | A2 (small separate PR) |
| G10 | No provider-side alternative when the final CDN refuses CORS | M3 finding, `refine.ts` | iPhone can't play typical RD MKV | C |
| G11 | Expired signed link has no recovery path | no re-resolve | Must re-paste | C |

---

## 6. Architecture

```
paste ──► prepareSource (URL + header probe: kind, file name, content type)
              │  room snapshot carries MediaSource (no credentials)
              ▼
each device:  capabilities snapshot (feature detection, no UA sniffing)
              │
              ▼
          planPlayback(source, caps) ──► ordered engines + reasons
              │                          e.g. HLS on WebKit: [native, hls.js]
              ▼                               MKV, VideoDecoder: [movi, native]
          RoutedPlayer (generalised FallbackPlayer)
              • one engine at a time, max one switch, local only
              • position / play / volume / mute carried; revision untouched
              • Movi RANGE_BLOCKED → resolver once (unchanged)
              • every attempt → diagnostics record (sanitised)
              ▼
          PlayerAdapter (unchanged contract) ──► sync engine, subtitles overlay
```

Later phases plug in without changing the sync contract:
- **B**: health checks inside RoutedPlayer (frames advancing, audio
  present) turn silent failures into AUDIO_UNSUPPORTED / VIDEO_UNSUPPORTED
  and trigger the existing one-switch fallback.
- **C**: a provider step before the engines: for an RD link, the server
  (host token, never sent to the browser) asks `/streaming/transcode/{id}`
  and returns the `apple` link as an extra candidate source for devices whose
  plan is empty or failed. The room keeps the original source; the variant is
  local to that device, checked against duration from
  `/streaming/mediaInfos/{id}` before use.

No new runtime dependency is needed for Phases 1–B.

---

## 7. Phases

| Phase | Scope | Expected gain (cells in §4) | Cost | Performance |
| --- | --- | --- | --- | --- |
| **1 (this PR)** | Capability snapshot; `planPlayback` routing (native HLS on WebKit, capability-gated Movi, DASH needs MSE, content-type routing); generalised one-switch RoutedPlayer; error codes; sanitised diagnostics panel with Copy; `?routing=legacy` kill switch | HLS without CORS on iPhone/Safari ❌→🟡; HLS with CORS: AirPlay + native codecs on iPhone; unsupported devices get a specific error instead of a 15 MB download; every failure has a code | No new dependency; a few KB of client JS; no server cost | Native HLS uses Safari's hardware pipeline instead of hls.js transmuxing in JS: less CPU and battery on iPhone. Capability probes run once per page, async ones only when the panel opens |
| A2 | Pin DNS for probe/resolver (connect only to the checked address) | Closes G9 | Small, server only | None |
| B | Silent-audio / frozen-video detection; `navigator.audioSession.type = "playback"` while Movi plays; audio track selection on Movi/HLS; forward-only mode only if seek/sync can be honoured (else explicit RANGE_UNSUPPORTED) | AC-3 MP4/MKV on Chrome: silent ❌ → Movi 🟡; Movi on iPhone in silent mode: silent → 🟡 | No dependency | A health timer (~1 s) during the first seconds of playback |
| C | Optional, host-only RD integration: server-side token (encrypted at rest only if Hassan approves storage), `/unrestrict/link` (`remote=1` only after testing), `/streaming/transcode`, `/streaming/mediaInfos`; per-device variant with duration/episode check | Typical RD MKV/AVI/DTS on iPhone: ❌ → 🟡 via provider HLS | RD API quota and traffic on the host account; transcode start latency | RD transcodes on its servers; nothing proxied by Vercel |

Rules kept in every phase: no Vercel byte proxy, no DRM/access-control
bypass, no tokenised URL or key in logs/diagnostics/tests, Arabic subtitles
and 0.35 s drift budget unchanged, PR #4 independent, real iPhone test before
merge.

---

## 8. OSS options considered

| Project | Version | License | Decision | Why |
| --- | --- | --- | --- | --- |
| hls.js (via hls-video-element) | 1.7.3 | Apache-2.0 | KEEP | Non-Safari HLS; now second choice on WebKit |
| dash.js (via dash-video-element) | 5.2.1 | BSD-3-Clause | KEEP | DASH on MSE/MMS |
| movi-player | 0.4.1 | Apache-2.0 | KEEP; reuse `assessPlayback` / `getMediaInfo` for diagnostics in B | Only engine that decodes MKV/HEVC/AC-3/DTS in-browser |
| Shaka Player | 5.x | Apache-2.0 | REJECT for now | Duplicates hls.js + dash.js; no evidence the current engines fail where Shaka succeeds |
| libmedia | – | LGPL-3.0 | REFERENCE ONLY | LGPL; overlaps Movi |
| ffmpeg.wasm | – | MIT/LGPL (core GPL builds exist) | REJECT | Whole-film transcoding on a phone is not realistic |
| Browser APIs: `canPlayType`, `MediaSource`/`ManagedMediaSource.isTypeSupported`, `VideoDecoder`/`AudioDecoder.isConfigSupported`, `MediaCapabilities.decodingInfo` | – | built-in | USE | Capability snapshot; still confirmed by actually playing |

---

## 9. Hard limitations that remain

- A non-native file (MKV/AVI/DTS/TrueHD…) on a CDN that sends no CORS can't
  be decoded by any web page on iPhone. Only a provider-side transcode
  (Phase C) or a native app can play it. Desktop has the extension.
- DRM-protected media will never play.
- AV1 on iPhones before 15 Pro, and 4K HEVC Main10 in Movi on older phones,
  may be too slow; the router can only report it.
- DASH needs iOS 17.1+ (Managed Media Source).
- Home Screen Web App: no element fullscreen (PR #4 handles immersive mode);
  Web Audio stops in the background.
- Provider transcodes may differ in timeline/duration from the original; the
  variant is only used after a duration check, and subtitles may need the
  shared offset adjusted.
- Real-Debrid quotas, IP rules (error 22) and traffic limits apply to the
  host account and can't be worked around.

---

## 10. Real iPhone test plan (required before merge)

Engine switching rules in Phase 1 (one switch per source, never a loop):

| First engine fails with | Switches to the next engine? |
| --- | --- |
| Safari HLS: can't decode (`MEDIA_ERR_SRC_NOT_SUPPORTED` / `DECODE`) | yes, hls.js |
| Safari HLS: `MEDIA_ERR_NETWORK` | yes, hls.js (it retries segments itself) |
| Safari HLS: no metadata within 15 s and no error | yes, hls.js (code NETWORK_TIMEOUT) |
| Safari HLS: stalls after it started | no (ordinary buffering; sync handles it) |
| `<video>` file: can't decode | yes, Movi |
| `<video>` file: network error | no (Movi would hit the same server) |
| Movi: anything | yes, `<video>` (after the redirect resolver for Range/CORS) |
| DRM | never |
| The second engine fails | no third try; error shown and recorded |

Baseline note: this branch starts from `c1db769` and does not contain PR #4
(iPhone immersive fullscreen and subtitle layout). A video-only native
fullscreen on a PR #6 preview is the pre-#4 behaviour, not a regression. Once
#4 is merged, #6 is updated onto it and re-checked for intrinsic sizing,
full-window immersive mode, Arabic cues and sync.

HLS test sources: Apple's examples
(https://developer.apple.com/streaming/examples/), e.g.
`https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8`.
For the no-CORS cell, first confirm with `curl -sI -H "Origin: https://<preview host>"`
that the master playlist, a media playlist and a segment all lack
`Access-Control-Allow-Origin`; a public URL is not no-CORS by default.

Host and guest on separate devices; Safari tab **and** Home Screen Web App.
For each row record the diagnostics panel's Copy output (it contains no URLs
or tokens) and one of PASSED / FAILED / UNSUPPORTED_BY_PROVIDER /
DRM_AUTH_REQUIRED.

1. Silo S03E01 RD MP4 + SubDL Arabic subtitle (regression): play, seek 30 min,
   pause/resume, subtitle at original offset, two viewers in sync, reconnect.
2. Public HLS with CORS (e.g. Apple's bipbop advanced example): engine should
   read `native` on iPhone/Safari, `hls.js` on Chrome.
3. HLS without CORS: native should play on iPhone; Chrome shows an error code.
4. MKV H.264/AAC on a CORS host (raw.githubusercontent.com test1.mkv): Movi.
5. RD MKV (final CDN without CORS): FINAL_CDN_CORS_BLOCKED on iPhone (until C).
6. DASH (`.mpd`) on iPhone ≥ 17.1.
7. Expired link (403/404/410) → EXPIRED_OR_UNAUTHORIZED.
8. `?routing=legacy` on the same HLS link to compare old vs new engine.

### Real-device results so far (iPhone Safari tab, reported by Hassan, 2026-10-08)

| Test | Routing | Engine shown | Result |
| --- | --- | --- | --- |
| Apple bipbop advanced fMP4 HLS | legacy | hls.js | PASSED (picture + sound) |
| Same | smart | Browser player (Safari HLS) | PASSED (picture + sound) |
| Same, two devices | smart | Browser player | PASSED (stayed in sync, user-observed; no measured drift) |
| 30-min seek / pause / reconnect | – | – | not yet run |
| Home Screen Web App | – | – | not yet run |
| No-CORS HLS (public test host, playlist sent without `Access-Control-Allow-Origin`, checked with `curl`) | legacy | hls.js | FAILED as expected (`NETWORK_ERROR`, single attempt) |
| Same | smart | Browser player (Safari HLS) | PLAYING (416×234, 1 audio, ready 1906 ms); picture + sound not yet confirmed by the user for this run |
| AirPlay | – | – | not yet run |

Diagnostics showed `0×0` / `0 audio` during these runs because Safari and
hls.js report size and audio tracks only after the first frames; fixed in
`3e9ce67` / the following commit to show "unknown" and refresh at playback.
