# Playback failure reasons

Why a video failed on one device, told apart from what the engines say.

## The problem (iPhone, 2026-10-09)

On a Saudi connection a real iPhone showed *"This source is not browser
compatible. Neither the browser nor the fallback decoder could play it."* With
a VPN turned on, the same link played on the same phone. So the message was
wrong. A connection that fails to reach the host is not a codec problem. The
VPN result shows only that the network path matters. It does not show why:
the source's own filtering, CDN routing, IP reputation, DNS or routing could
each explain it. The app makes no such claim.

How the old code produced that sentence:

- Safari's `<video>` reports a host it can't connect to as
  `MEDIA_ERR_SRC_NOT_SUPPORTED`, which `describeMediaError` turned into
  "not browser compatible".
- `classifyMoviError` sent any error text it didn't recognise to `codec`, which
  became `MOVI_INCOMPATIBLE_MESSAGE`. This includes timeouts, `HTTP 5xx` and
  Safari's own fetch error, "Load failed".
- `FallbackPlayer.finalMessage` then showed the second engine's sentence, so
  "both decoders can't play it" won even when neither one ever got a byte.
- `browserCanRead` (used by the redirect resolver) took any thrown fetch as
  "CORS blocked", so an unreachable host could also be reported as "blocks
  browser streaming".

## What happens now

When every engine on a device has failed, and the engines' reason could be
the network, `FallbackPlayer` runs one check before the viewer is told
anything (`lib/media/reachability.ts`, bounded to 6 s). Failures that are
already specific skip it: DRM, no engine on this device, not media, an
expired link, or a final CDN without CORS.

| Check | How | What it can tell |
| --- | --- | --- |
| This browser, CORS | `GET`, `Range: bytes=0-0`, `credentials: omit` | the first byte is readable (2xx/206), or the HTTP status this device got |
| This browser, `no-cors` (only if the CORS read threw) | same URL, opaque, aborted as soon as it answers | whether the server answered at all: a CORS refusal versus no answer |
| Watch Party's server | the existing `/api/media/resolve` header check: same SSRF guard, one byte asked for, body cancelled unread, nothing logged | whether the link answers from outside this device's network |

The page never routes media through Vercel, and nothing is retried through the
server.

## Codes

| Code | When | Viewer sees |
| --- | --- | --- |
| `NETWORK_UNREACHABLE` | no answer reached this device | "...couldn't be reached from this device, but the same link answered Watch Party's server. The connection from this device's network to that server failed, so another network may work." If the server failed too: "Neither this device nor Watch Party's server could reach..." |
| `NETWORK_TIMEOUT` | this device's check timed out, or Movi stopped getting data | "...didn't answer this device in time..." |
| `HTTP_DENIED` | this device **saw** 401, 403 or 451 | "...refused this device (HTTP 403). The link may have expired, or that server may not allow this device." |
| `EXPIRED_OR_UNAUTHORIZED` | saw 404/410, or the engines' own 401/403/404 text | "The video link wasn't found..." |
| `SOURCE_UNAVAILABLE` | saw another error status (5xx, 429) | "...answered this device with an error (HTTP 502)." |
| `CORS_BLOCKED` / `RANGE_UNSUPPORTED` / `FINAL_CDN_CORS_BLOCKED` | the server answered this device, but this page can't read it | the existing CORS sentences |
| `STREAM_START_TIMEOUT` | Safari's HLS player never reached metadata (this was `NETWORK_TIMEOUT` before) | "The stream didn't start loading." |
| `CODEC_UNSUPPORTED` | a decoder refused it **and** this device read the bytes | the existing "not browser compatible" sentence, now confirmed |
| `UNKNOWN` | the browser hides the cause: an opaque answer plus a decoder complaint, or Movi text we don't recognise | says so: "...doesn't say why" |

Per-attempt rows in diagnostics still show what each engine said, for
example `FORMAT_UNSUPPORTED` from `<video>`. The final code is the verdict above.

**No automatic claims.** No sentence names censorship, a country, an ISP or a
block. "Another network may work" appears only when our server got an answer
and this device got none, which is what was observed. A status such as 403 or
451 is shown only when this device actually read it.

**Limits.**
- An opaque `no-cors` answer hides its status. A CDN that returns 403 without
  CORS headers to one network looks like "answered". When our server can read
  the same link with CORS, the viewer is told the answers differ and that the
  cause is unknown.
- Some browsers' opaque-response blocking may turn a blocked opaque answer
  into a network error. In that case "unreachable" can over-report, which is
  why the server comparison is shown next to it.
- The browser check runs after the engines failed. A flaky network can change
  between the two.

## Diagnostics report (Playback details → Copy)

New fields, with no URL, path or query:

- `reachability`: `{ browser: "unreachable", server: "ok 206 cors:allowed" }`
- `userAgent`: browser and OS version (iOS / WebKit). The browser already sends
  this to every site.
- `error.code`: the verdict above. The per-attempt rows keep the engine order,
  the codes, and the ready and playing times.

## Real-device check (Hassan)

Use the same link on the same iPhone, with Safari and the Home Screen app
recorded separately:

1. VPN **off**: paste the link and wait for the error. Open Playback details,
   press Copy, and paste the report. Expected: `NETWORK_UNREACHABLE` (or
   `HTTP_DENIED` with a status) and `reachability.browser` = `unreachable`.
2. VPN **on**: the same link plays. Copy the report (attempts reach
   `playing`).
3. If the link has an HLS form, repeat with it.
4. With VPN on, host and guest play, pause, seek and stay in sync as before.

Don't paste the video URL itself. The report already contains only the host.
