# Universal Link Playback: audit (2026-10-09)

Audit of `main` at 3f8f7cf (after PR #7) before PR A. PR #8 (Real-Debrid
compatibility lab) is out of scope and stays separate: its Apple HLS discovery
worked, but RD HLS stalled on a real iPhone (readyState 1, no decoded frame),
so it is not a fallback.

## What already works (kept as is)

| Area | Where | State |
| --- | --- | --- |
| One-field Paste & Play | `components/RoomView.tsx` `SourceForm` → `lib/media/prepare.ts` | Direct URLs decided from the URL alone (no request) |
| URL classification | `lib/media/source.ts` `resolveSource` | Extensions for MP4/MOV/WebM/MKV/AVI/TS/M2TS/WMV/FLV/audio, `.m3u8`, `.mpd`; YouTube and Vimeo ids |
| Extensionless links | `lib/media/probe.ts` + `/api/probe` | HEAD, then 2 KB ranged GET; Content-Type, Content-Disposition, `#EXTM3U`/`<MPD` sniff |
| Engine routing | `lib/media/route.ts` `planPlayback` + `capabilities.ts` | Safari native HLS first; hls.js/dash.js on MSE/MMS; Movi for MKV-family containers; `?routing=legacy` kill switch |
| Fallback | `lib/player/fallback.ts` | **Already bounded**: at most one engine switch per source, one redirect refinement, DRM terminal, local only (no revision bump), position/play/volume/mute/rate carried |
| Redirect resolver | `lib/media/resolve-stream.ts` + `/api/media/resolve` | Per-hop guard, 1-byte Range, no cookies, no logging, never relays bytes |
| Providers | `lib/player/media-element.ts` (youtube-video-element), `lib/player/vimeo.ts` (official SDK) | Unchanged |
| Diagnostics | `lib/media/diagnostics.ts`, `components/PlaybackDiagnostics.tsx` | Host + extension only, never URLs |
| Sync, subtitles, fullscreen | `components/useWatchParty.ts`, `lib/sync`, `lib/subtitles`, `lib/fullscreen.ts` | Unchanged by PR A |

## Gaps found

1. **Ordinary web pages were rejected.** A pasted article/video page made the
   probe answer `not_media` and the viewer saw "This source can't be played
   directly." There was no Open Graph, JSON-LD, `<video>` or oEmbed discovery.
   → PR A adds safe page discovery.
2. **SSRF: IPv4-mapped IPv6 bypass (real).** `new URL("http://[::ffff:127.0.0.1]/")`
   serialises the host as `[::ffff:7f00:1]`. The old `isPrivateAddress` only
   unwrapped the dotted form, so the hex form passed as public and the probe,
   resolver and subtitle fetch would have connected to loopback. Same for
   NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), Teredo, IPv4-compatible `::/96`
   and several reserved IPv4 blocks (198.51.100/24, 203.0.113/24).
   → Fixed: `lib/net/address.ts` (ipaddr.js range table, IPv6 restricted to 2000::/3).
3. **SSRF: DNS rebinding / TOCTOU (real).** `assertPublic` resolved the host,
   then the global `fetch` resolved it again. A rebinding host could pass the
   check and connect to 127.0.0.1 or 169.254.169.254.
   → Fixed: `lib/net/pinned-fetch.ts` checks addresses inside the socket's own
   DNS lookup; probe, resolver and subtitle-link fetches now use it by default.
4. **Overbroad block (bug).** `192.0.0.0/16` was refused, which includes
   192.0.78.x (WordPress.com hosting). Now only 192.0.0.0/24 and 192.0.2.0/24.
5. **No rate limiting** on endpoints that fetch pasted URLs. → PR A adds a
   per-client/per-instance limiter on the new discovery endpoint (see the
   security review for what that does and does not cover).
6. **Attempt budget.** Already deterministic (one switch, one refinement), so
   no change: adding loops would be a regression risk with no observed failure.
7. **Recognised-but-unsupported services** (Dailymotion, Twitch, Netflix...)
   fell into the generic probe path and failed with a generic message.
   → Named immediately with no request (`NO_EMBED_AVAILABLE` / `DRM_LICENSE_REQUIRED`).

## Not changed in PR A (and why)

- Direct-media fast path: identical. Known extensions, YouTube and Vimeo make
  no server request (unit test `prepare.test.ts` asserts zero fetches).
- Engines, routing, fallback, sync, subtitles, fullscreen, RD code: untouched.
- Extensionless MIME/redirect handling: no demonstrated gap beyond SSRF.
- Frame/audio verification and expanded error taxonomy at playback time: PR C.
- New provider SDKs (Dailymotion, Twitch, Wistia, Streamable): PR B.
- yt-dlp / Streamlink worker: PR D, only if real links justify it.

## Phase gates

| PR | Gate to start | Gate to leave draft |
| --- | --- | --- |
| A | — | Unit + E2E green; real public pages tested on the Preview; iPhone Safari + Home Screen check by Hassan; no regression in proven MP4/HLS/MKV/Torrentio-RD links |
| B | A accepted | Each provider: play/pause/seek/position verified with its SDK on desktop and iPhone |
| C | B accepted | Startup-hang and silent-failure detection proven on real failing links |
| D | Real link set that A–C can't play but a metadata-only extractor can, with actual playback | Isolation, limits, legal review |
