# Implementation plan

Small, vertical milestones. Each one is run, tested and committed before the next.

## Architecture (kept deliberately small)

- **Next.js App Router** pages: `/` (create/join) and `/room/[id]` (player).
- **No database in V1.** Room state lives in the host tab and travels over
  **Supabase Realtime Broadcast**; **Presence** tracks who is connected and
  their ready/buffering status.
- **Host is authoritative.** On play/pause/seek (and a 3s heartbeat while
  playing) the host broadcasts `{ playing, positionSeconds, refTime, revision, hostId }`.
- **Shared clock.** Every client estimates its offset to the server via
  `GET /api/time` (lowest-RTT of 5 samples), so `refTime` means the same
  instant for everyone regardless of local clock skew.
- **Drift correction** (guest, every 250ms): `< 0.35s` nothing, `0.35–1.25s`
  playbackRate 0.95–1.05 until under 0.1s, `> 1.25s` hard seek (2s cooldown).
- **Reconnect.** A guest that (re)joins sends `snapshot_request`; the host
  replies with `{ media, state, settings }`. The host keeps its session in
  `sessionStorage`, so a host reload resumes the room where it should be.
- **Real-Debrid** (Milestones 3–4) lives in `lib/realdebrid/` behind a
  route handler; tokens stay server-side, only the resolved media URL reaches
  the browser, and video bytes go browser → CDN directly (never via Vercel).
- **Local mode.** Without Supabase env vars the transport falls back to
  `BroadcastChannel`, so two tabs of one browser sync with no backend. This is
  what the automated tests use.

## Milestones

1. Two tabs create/join a room and sync a direct MP4. ✅
2. Verify sync from two separate devices (needs a Supabase project + deploy/tunnel). ✅
3. Host Real-Debrid: `lib/realdebrid/{client,resolve,types}.ts`, `POST /api/resolve`
   using `REAL_DEBRID_TOKEN`, explicit RD error mapping. ✅
4. Guest Real-Debrid: guest pastes their own token, resolved per request, never stored.
5. Deploy to Vercel and run the end-to-end test on the deployment.
