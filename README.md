# Watch Party

Private, invite-only synchronized video playback for a small group (built for 2,
designed to allow more). Next.js + TypeScript + Tailwind + Supabase Realtime, deployed on Vercel.

Status: **Milestone 3** (universal paste-and-play). See [docs/PLAN.md](docs/PLAN.md).

## How it works

- The host creates a room (`/room/F8K2Q9`), loads a source, and shares the link.
- Guests open the link and join without an account.
- The host is authoritative: play, pause and seek are broadcast over Supabase
  Realtime with a server-clock reference timestamp; guests compute where they
  should be and correct drift (rate nudge for small drift, seek for large).
- Presence shows who is connected and whether they are ready or buffering.
  The host can enable "Pause when a participant buffers".
- Refresh/reconnect: guests ask the host for the latest state and jump back in.

## Paste and play

The host pastes any link into **Paste anything to watch** and presses **Play**.
The app works out the source type; nobody picks a mode.

| Source | Detected by | Player |
| --- | --- | --- |
| MP4, WebM, MOV, MKV, audio files | file extension | native `<video>` |
| HLS | `.m3u8` | `hls-video-element` (hls.js; native HLS on Safari/iOS) |
| MPEG-DASH | `.mpd` | `dash-video-element` (dash.js, loaded only for DASH) |
| YouTube | youtube.com / youtu.be / shorts / embed / live links | `youtube-video-element` (official IFrame Player API) |
| Vimeo | vimeo.com / player.vimeo.com links (incl. unlisted hash) | official Vimeo Player SDK |
| Final CDN/download URLs (Real-Debrid, Torrentio, Nuvio, ...) | extension, else server probe | whichever of the above fits |

**Detection** (`lib/media/source.ts` → `resolveSource`) uses the URL alone. When the
path gives no hint, `POST /api/probe` (`lib/media/probe.ts`) reads only the response
headers (HEAD, falling back to the first 2 KB) to tell file / HLS / DASH / web page
apart. It refuses private, loopback and link-local addresses on every redirect hop,
and if it can't tell, the HTML5 player simply tries. Video bytes never pass through Vercel.

**Players** (`lib/player/`) all implement one `PlayerAdapter` interface
(`load, play, pause, seek, currentTime, duration, playing, destroy`, plus a few
status getters and a uniform event stream). Files, HLS, DASH and YouTube go
through one `MediaElementAdapter` over the media-element web components that
react-player 3 is built on; Vimeo uses a thin wrapper over the official Player
SDK. The sync engine (`components/useWatchParty.ts`) only talks to the
interface. Library choices and licenses: [docs/OSS_REUSE_AUDIT.md](docs/OSS_REUSE_AUDIT.md).
Providers without fine-grained playback rates (YouTube; Vimeo on basic accounts)
correct drift by seeking only, with a 0.6 s dead band.

**Can't be played directly:** web pages, DRM-protected media, private or
embed-disabled YouTube/Vimeo videos, playlists/channels, non-http(s) links, and
links that need a login show "This source can't be played directly." So does a
YouTube/Vimeo player that never becomes ready within 20 s (for example YouTube's
"confirm you're not a bot" check, which it shows to datacenter IPs). Media the
browser can't decode shows "This source is not browser compatible." There is no
DRM bypass, server-side download or transcoding.

## Subtitles

The host uploads a `.srt` or `.vtt` file or pastes a subtitle link (links the
browser can't fetch because of CORS go through `POST /api/subtitles`, capped at
2 MB). SRT is parsed by srt-parser-2 and WebVTT by the browser's own parser;
Windows-1256 Arabic files are decoded too. The file travels to guests in the
room snapshot (deflated), so late joiners get it. Cues are drawn over the player,
so they work over YouTube/Vimeo as well, right-to-left where the text is. The
host's delay (±0.5 s steps) applies to everyone; show/hide is per viewer.
**Fullscreen** under the player keeps the subtitles visible.

**Find Arabic subtitles** (host) searches OpenSubtitles and SubDL from our
server (`POST /api/subtitles/search`, `POST /api/subtitles/download`). What to
look for comes from the media file name (parsed by parse-torrent-title), the
YouTube/Vimeo title (oEmbed), or a title the host types when neither is enough.
Results are ranked with subliminal's weights (see `docs/OSS_REUSE_AUDIT.md`) and
each shows its score and why it matched. The best one is applied automatically
only when it matches the exact release, the IMDb id, title + year, or series +
season + episode; otherwise the host picks from the top five. A chosen subtitle
is shared exactly like an uploaded one, so delay, show/hide and late joiners work
the same. Search is disabled until at least one provider key is set.

The Milestone 3 Host Real-Debrid code (`lib/realdebrid/`, `POST /api/resolve`) is
kept isolated but is not part of the UI; it does nothing unless `REAL_DEBRID_TOKEN` is set.

## Local setup

Requirements: Node 20+ (22 recommended), npm.

```bash
npm install
cp .env.example .env.local   # fill in values, or leave Supabase empty for local mode
npm run dev                  # http://localhost:3000
```

**Local mode:** if `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
are empty, the app syncs between tabs of the *same browser* only (BroadcastChannel)
and shows a banner. Configure Supabase to sync across devices.

## Supabase configuration

No tables or SQL are needed for Milestone 1; only Realtime Broadcast and Presence are used.

1. Create a project at <https://supabase.com/dashboard>.
2. Project Settings → API: copy the **Project URL** and the **anon / publishable** key into
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Realtime → Settings: make sure public channels are allowed
   (i.e. "Allow public access" is on / "private channels only" is off).
   Rooms use channels named `room:<CODE>`.

The anon key is designed to be public. Never put the Supabase **service role** key or
any Real-Debrid token in a `NEXT_PUBLIC_` variable.

## Environment variables

| Name | Where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser | Supabase anon key (Realtime only) |
| `REAL_DEBRID_TOKEN` | server only | Optional, unused by the UI (dormant Host Real-Debrid route) |
| `OPENSUBTITLES_API_KEY` | server only | Enables OpenSubtitles in "Find Arabic subtitles" (free consumer key from opensubtitles.com) |
| `OPENSUBTITLES_USERNAME`, `OPENSUBTITLES_PASSWORD` | server only | Optional; logging in raises the daily download quota |
| `SUBDL_API_KEY` | server only | Enables SubDL in "Find Arabic subtitles" (subdl.com account) |

`.env*` files are git-ignored except `.env.example`.

## Deploying to Vercel

1. Import the GitHub repo in Vercel (framework preset: Next.js).
2. Add the variables above in Project → Settings → Environment Variables.
3. Deploy. `NEXT_PUBLIC_*` values are inlined at build time, so redeploy after changing them.

## Scripts

```bash
npm run dev        # dev server
npm run build      # production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # unit tests (drift math, clock offset, ids, source detection, probe safety, Real-Debrid parsing)
npm run e2e        # browser suite per source type (local mode, generates test media with ffmpeg)
```

`npm run e2e` needs `ffmpeg` and Playwright's Chromium (`npx playwright install chromium`
if you don't have it). Set `CHROMIUM_PATH` to use a specific Chromium binary.
The suite answers YouTube's and Vimeo's script URLs with stand-ins
(`tests/e2e/fakes/`) that implement the same API on the test clip; set
`E2E_REAL_PROVIDERS=1` to load the real ones. Test media is VP9/Opus because
Playwright's Chromium has no H.264.

## Playback compatibility

Sources the browser can't decode (e.g. many MKV/HEVC/TrueHD files) show
**"This source is not browser compatible."** Transcoding is out of scope for V1.

## Security notes

- The Real-Debrid token is only read on the server (`lib/realdebrid/client.ts` imports
  `server-only`); it never appears in HTML, bundles, Realtime messages, URLs or logs.
  Only the generated media URL is shared with the room, because guests need it to play.
- Subtitle provider keys are read only in `lib/subtitles/search/` (`server-only`). The
  OpenSubtitles key goes in a request header; signed download links are fetched on the
  server and never returned, logged or shared. Search sends only the media file name,
  never its query string.
- Media labels shown in the UI strip query strings (signed URLs often carry tokens).
- Room codes are random 6-character codes. Supabase public channels are reachable by
  anyone who knows the code; treat the invite link as the secret.
