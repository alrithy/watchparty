# Universal resolver architecture

```
pasted text
  │ resolveSource (browser, no request)            lib/media/source.ts
  ├─ known extension / YouTube / Vimeo ──────────────────────────────▶ room source (fast path)
  ├─ recognised service (Dailymotion, Netflix…) ─▶ named error, no request
  │ /api/probe (headers + 2 KB)                     lib/media/probe.ts
  ├─ media / HLS / DASH by headers ──────────────────────────────────▶ room source
  ├─ unknown (blocked, timeout) ─────────────────▶ browser tries (unchanged)
  └─ web page (text/html, JSON)
       │ /api/media/discover                        lib/media/discover/discover.ts
       ├─ fetch page: guarded, pinned, ≤5 hops, ≤2 MB, 8 s
       ├─ extract: JSON-LD VideoObject, og:video*, twitter:player*,
       │           <video>/<source>, provider <iframe>, oEmbed links   extract.ts
       ├─ embeds → official SDK providers only (YouTube, Vimeo)        providers.ts
       ├─ media candidates → header probe (≤4, parallel) = verification
       ├─ no result → trusted oEmbed endpoint → its iframe src only
       └─ choose():  one confident video ─▶ room source
                     several / low confidence ─▶ host picks (SourcePicker)
                     none ─▶ specific code + sentence
room source → planPlayback (capabilities) → FallbackPlayer / provider adapter (unchanged)
```

## Contracts

- `MediaSource` (shared with the room) gains optional `page: { host, via }`:
  the page's host and how the video was found. No page path or query (they
  can carry tokens). `url` is the video URL exactly as the page gave it
  (HTML entities decoded, resolved against the page/`<base>`, query untouched).
- `DiscoveryResult` (`lib/media/discover/types.ts`):
  `source` (one `DiscoveredOption`), `choose` (≤6 options) or `unsupported`
  with a `DiscoveryErrorCode`: `PAGE_NOT_MEDIA`, `NO_EMBED_AVAILABLE`,
  `PROVIDER_EMBED_BLOCKED`, `AUTH_REQUIRED`, `DRM_LICENSE_REQUIRED`,
  `LINK_EXPIRED`, `NETWORK_TIMEOUT`, `SOURCE_UNAVAILABLE`,
  `BLOCKED_DESTINATION`, `RATE_LIMITED`.
- `DiscoveredOption`: `source`, `via`, sanitised `title`, `duration` (s),
  `verified` (the server saw a media response, not just a URL in metadata).

## Selection rules (`choose`)

1. Candidates are grouped by identity: Open Graph, Twitter and a single
   JSON-LD VideoObject describe the page's **main** video; each `<video>`
   element is one video (its `<source>`s are renditions); several JSON-LD
   VideoObjects with different names are different videos; each iframe is one.
2. Media candidates count only if the header probe confirms media
   (`verified`), or the probe could not reach them **and** the URL/declared
   type plainly says media (`verified: false`, never auto-played).
3. Dropped: background loops (`autoplay muted loop` without `controls`), ad
   hosts and VAST/VPAID URLs, image URLs, non-http(s), userinfo URLs.
4. Weights: JSON-LD 50, Open Graph 40, Twitter 35, oEmbed 30, `<video>` 20
   (+10 if it is the page's only one, −10 otherwise), iframe 10; +20 verified;
   +5 on `og:type=video.*`. Best rendition per identity.
5. Auto-play only one verified option that isn't a lone iframe. Everything
   else goes to the picker; nothing plays until the host clicks.

## Synchronisation and identity

Discovery runs once, on the host, before `loadMedia`. Guests receive the
resulting `MediaSource` through the normal room snapshot, so the room
revision, sync clock, subtitles and delay work exactly as for a pasted direct
link. Local engine switches remain local (no revision change).

## Extending

- New provider with an SDK: add an adapter (PR B) and move it from
  `RECOGNISED_PROVIDERS` to `PLAYABLE_PROVIDERS`; `providerSource` maps embeds.
- New metadata rule: add it to `extract.ts` with a `via` and a weight.
- Optional extractor (PR D): a separate `discover` step behind a disabled flag,
  only consulted after the steps above return nothing.
