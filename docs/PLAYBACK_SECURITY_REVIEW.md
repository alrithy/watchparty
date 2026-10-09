# Playback security review (PR A, 2026-10-09)

Scope: every server request made from a pasted URL (`/api/probe`,
`/api/media/resolve`, `/api/media/discover`, `/api/subtitles` link fetch) and
what the browser receives back. Reference: OWASP SSRF Prevention Cheat Sheet.

## SSRF controls

| Requirement | Control | Where | Test |
| --- | --- | --- | --- |
| http/https only | scheme check before any request; extracted URLs with other schemes dropped | `assertPublic`, `pinnedFetch`, `extract.ts absolute()` | `ssrf.test.ts`, `discover.test.ts` |
| Block private/metadata/link-local/reserved, v4 + v6 | `isPublicAddress`: ipaddr.js `range() === "unicast"` after unwrapping IPv4-mapped; IPv6 must be in 2000::/3 | `lib/net/address.ts` | 30-row table incl. `::ffff:7f00:1`, NAT64, 6to4, Teredo, `::7f00:1`, 169.254.169.254 |
| Every redirect hop | manual redirects, guard on each hop, loop detection, max 5 | probe, resolver, `fetchGuarded` | redirect-to-metadata, loop, 10-hop chain |
| DNS rebinding / TOCTOU | address check inside the socket's DNS lookup; connection can only use a checked address; any non-public address in the answer refuses the host | `lib/net/pinned-fetch.ts guardedLookup` | `localhost` refused at connect time; rebinding resolver test |
| Unusual ports | 80, 443, 8080, 8443 only | `assertPublic` | port 6379 refused |
| Hostnames | `localhost`, `*.localhost`, `*.internal` refused; userinfo URLs refused | `assertPublic`, `pinnedFetch` | ✓ |
| Timeouts | page 8 s, oEmbed 4 s, probe 6 s, resolver 9 s | | timeout test |
| Response bytes | HTML ≤ 2 MB (prefix read, rest cancelled; decompressed bytes counted, so gzip bombs stop at 2 MB), oEmbed ≤ 64 KB, JSON-LD block ≤ 256 KB × 12, probe sniff 2 KB | `readText`, `extract.ts` | oversized page test |
| Concurrency | ≤4 candidate probes per page; ≤8 discoveries in flight per instance | `discover.ts`, `RateLimiter` | ✓ |
| Rate limiting | 20 discoveries / minute / client IP per instance → 429 `RATE_LIMITED` | `lib/http/rate-limit.ts` | ✓ |
| Cross-site use | same `isCrossSite` check as existing routes | route | — |
| No credentials | `authorization`, `cookie`, `proxy-authorization` removed whatever the caller passes; `Set-Cookie` dropped; no keep-alive agent | `pinnedFetch` | header strip test |
| No script execution | HTML is tokenised (htmlparser2), never rendered; scripts ignored except JSON-LD parsed with `JSON.parse` | `extract.ts` | ✓ |
| oEmbed | only official endpoints of listed providers (exact origin + path, https, default port); the returned `html` is never shown, only an iframe `src` mapped to YouTube/Vimeo | `providers.ts`, `viaOembed` | untrusted endpoint never fetched; script/onload stripped |
| XSS via metadata | titles: control + bidi-override chars removed, 160 chars, rendered as React text; no `dangerouslySetInnerHTML` in the app | `cleanText`, `SourcePicker` | ✓ |
| Iframes | no third-party iframe from page content is ever embedded; only the existing YouTube/Vimeo player elements | `providerSource` | lookalike host test |

### Residual risks

- The in-memory limiter is per serverless instance. **Production action:** add
  a Vercel WAF rate-limit rule for `/api/media/*` (e.g. 30/min/IP).
- The OpenSubtitles download `link` and SubDL/OpenSubtitles API hosts are
  fixed provider endpoints and still use the global fetch (not user input).
- HTTP (not HTTPS) pages are still fetched; the content is public by
  definition, and the video URL is played by the browser, not the server.
- Test escape hatch `PROBE_ALLOW_PRIVATE=1` disables the address guard; it
  must never be set on Vercel (it is only set by the local Playwright config).

## Privacy: what is shared, logged and shown

- **Shared with room participants:** the room `MediaSource`, i.e. the playable
  video URL **including any signed query string**, the label (page title or
  file name), and `page.host` + `page.via`. Everyone in the room must be able
  to fetch the video, so a signed stream URL is not secret from the people
  you invite. It is never put in the invite link.
- **Not shared:** page path/query, page HTML, oEmbed bodies, probe headers.
- **Logs:** none of these routes log URLs; errors carry codes and fixed
  sentences only. Diagnostics show host + extension, never URLs.
- **Error messages** never echo the pasted URL.
- Real-Debrid tokens are not involved: discovery sends no Authorization
  header to any host, and RD code is untouched.

## Provider terms and access

Discovery reads only what a link-preview unfurler reads (public HTML
metadata), on an explicit user paste, with an honest User-Agent
(`WatchPartyLinkCheck/1.0`). It does not log in, send cookies, solve
challenges, or bypass DRM, paywalls or embed restrictions: 401/403 becomes
`AUTH_REQUIRED`, DRM services are refused up front.
