# Milestone 4 — Real-Debrid HLS compatibility gate (Phase C1)

Status: **experimental test lab**, separate from Watch Party playback. Not deployed to main until real account/iPhone verification. URL: `/rd-compat`.

## Official RD API reference
https://api.real-debrid.com/
- `GET /downloads?limit=30` returns IDs and recent download filenames; only ID, filename and size are returned to the browser.
- `GET /streaming/transcode/{id}` returns `apple` M3U8 quality links (and other protocols).
- `GET /streaming/mediaInfos/{id}` reports duration and codecs; metadata can fail independently.
- The ID MUST come from `/downloads` or `/unrestrict/link`. Never extract it heuristically from a Torrentio URL or RD CDN link.

## Privacy & operating model
- Every viewer uses their own Real-Debrid API key entered into a password field. This is sent directly to *this application's* same-origin serverless endpoint over HTTPS and forwarded by the server only to the fixed official API host with an Authorization Bearer header. It remains in local component memory only until tab reload/close (or Clear). It is never stored in sessionStorage/localStorage, environment, database, cookies, logs, room broadcasts or error reports.
- API accepts POST JSON only, same-origin checks, 8KB size cap, no-store/noindex response; fixed upstream URLs, no arbitrary host fetch, upstream redirects forbidden to protect Authorization header.
- Returned rendition URL is itself a **signed playback capability** and is visible in the local browser/player. It is not room-shared or stored server-side. Do not copy/share it.
- No video or manifest bytes are proxied through Vercel. Safari fetches provider HLS directly.
- RD account/IP restrictions, quotas, provider transcoding availability and device support cannot be confirmed from mocked tests. API queries may count towards provider limits.
- No claim that the API can be used anonymously without a personal token; never enable a globally shared host RD token from a public endpoint.

## Tests required from a real RD account
1. Open branch Preview `/rd-compat` from iPhone Safari.
2. Paste your own token there (NOT into a chat/message).
3. Choose a known download (e.g. Silo episode); get HLS links. Confirm real `apple` data is returned.
4. Play a quality, confirm *picture AND sound*, 30 min seek, duration. Check whether a guest on a different IP with their own authorized access can also play; do not publicly share signed URLs.
5. Compare original and rendition durations. `durationCompatible` currently requires difference <= max(2 sec, 0.5%). Absence of duration disallows automated room switching.
6. Check whether the HLS URL stays valid / expires, audio language selection, subtitles match timeline, and switching quality works.

## Next implementation after real account PASS
- Bind a verified original media identity to RD's **documented** download ID, without link guessing.
- Local-only, per-viewer opt-in fallback in `useWatchParty` or a standalone adapter. Preserve original room MediaSource, revision, source subtitles, delay and server clock.
- Make rendition quality selection automatic by device capability and observed playback; ensure no infinite fallback loops.
- Add deterministic per-viewer auth UX and retries; handle guest multi-IP restrictions; get explicit user authorization before potentially consuming remote traffic.
- Keep original link working if no RD transcode exists. Never silently switch to wrong file, episode or timeline.

**Non-goals now:** autoplaying RD variants in rooms, globally shared RD credentials, proxying bytes, DRM circumvention, promising arbitrary MKV browser compatibility.
