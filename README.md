# Watch Party

Private, invite-only synchronized video playback for a small group (built for 2,
designed to allow more). Next.js + TypeScript + Tailwind + Supabase Realtime, deployed on Vercel.

Status: **Milestone 3** (rooms, direct URL sync, Host Real-Debrid). See [docs/PLAN.md](docs/PLAN.md).

## How it works

- The host creates a room (`/room/F8K2Q9`), loads a source, and shares the link.
- Guests open the link and join without an account.
- The host is authoritative: play, pause and seek are broadcast over Supabase
  Realtime with a server-clock reference timestamp; guests compute where they
  should be and correct drift (rate nudge for small drift, seek for large).
- Presence shows who is connected and whether they are ready or buffering.
  The host can enable "Pause when a participant buffers".
- Refresh/reconnect: guests ask the host for the latest state and jump back in.

## Host Real-Debrid

The host picks **Host Real-Debrid**, pastes a hoster link and clicks Load. The
browser sends only the link to `POST /api/resolve`; the server calls
`POST https://api.real-debrid.com/rest/1.0/unrestrict/link` with
`REAL_DEBRID_TOKEN` in the `Authorization` header and returns
`{ url, filename, mimeType, filesize }`. Host and guests then stream `url`
directly from Real-Debrid's CDN; no video bytes pass through Vercel.

- If Real-Debrid refuses the request because of an IP restriction (`error_code` 22,
  e.g. because Vercel runs on cloud IPs), the server retries once with `remote=1`,
  which uses the account's Remote traffic.
- Errors are mapped to clear messages: invalid/expired token, account locked,
  unsupported hoster, dead/unavailable link, hoster down, IP not allowed,
  traffic exhausted and rate limits (the API allows 250 requests/minute).
- Logs only ever include hostnames, never the token, the hoster link or the generated link.
- The route refuses cross-site browser requests. It has no other authentication,
  so anyone who can reach the deployment could spend the host's account: keep
  Vercel deployment protection on, or don't set the token on public deployments.
- Magnet/torrent links and guest Real-Debrid accounts are later milestones.

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
| `REAL_DEBRID_TOKEN` | server only | Host Real-Debrid API token (<https://real-debrid.com/apitoken>) |

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
npm test           # unit tests (drift math, clock offset, ids, url handling, Real-Debrid parsing/errors)
npm run e2e        # two-tab browser sync test (local mode, generates a test clip with ffmpeg)
```

`npm run e2e` needs `ffmpeg` and Playwright's Chromium (`npx playwright install chromium`
if you don't have it). Set `CHROMIUM_PATH` to use a specific Chromium binary.

## Playback compatibility

Native `<video>` is used first; `hls.js` is loaded only for `.m3u8` streams in browsers
without native HLS. Sources the browser can't decode (e.g. many MKV/HEVC/TrueHD files)
show **"This source is not browser compatible."** Transcoding is out of scope for V1.

## Security notes

- The Real-Debrid token is only read on the server (`lib/realdebrid/client.ts` imports
  `server-only`); it never appears in HTML, bundles, Realtime messages, URLs or logs.
  Only the generated media URL is shared with the room, because guests need it to play.
- Media labels shown in the UI strip query strings (signed URLs often carry tokens).
- Room codes are random 6-character codes. Supabase public channels are reachable by
  anyone who knows the code; treat the invite link as the secret.
