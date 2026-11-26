# Pause keep-alive

The panel allows one stream for the household, so the server frees a session
that has made no media request (manifest, segment, proxied bytes) for
`LIVE_IDLE_GRACE_MS` (180 s): the idle reaper drops the concurrency entry,
kills the transcoder and deletes its HLS dir. A **paused** player makes no
media requests, so a pause longer than ~3 min used to lose the session and the
resume failed (404 on the next segment; the TV app restarted).

## Contract

`POST /api/stream/heartbeat` (normal household auth), body `{ "mode", "id" }`.

| mode | sent? |
|---|---|
| `movie`, `series` (episode id), `disk` | yes, while paused |
| `live` | never (400) |

Server (`lib/pause-keepalive.js`):

- Only refreshes a session that **already exists** for that title and belongs
  to the caller: the caller's own owner key (web: session cookie), or an
  `ip:` owner from the caller's IP (Android players fetch media without
  cookies, so their owner is `ip:<ip>:<player UA hash>`).
- Bumps the entry's `lastSeen` and the current transcoder's `lastAccess`.
  Never creates a session, never spawns ffmpeg, makes no upstream request
  itself.
- Refreshes only the transcoder the player was actually reading (newest
  manifest/segment access); older variants of the title (a previous seek
  anchor, quality or audio track) keep aging out.
- The caller's cookie-owned session wins; `ip:` owners from the caller's IP are
  matched only when the caller has no session of its own for that title.
- A kept transcode whose ffmpeg was still encoding ahead keeps doing so (it
  already held the household slot); a provider drop during the pause
  self-heals exactly as during playback (one connection replaces the dead one).
- Bounded: ignored once the session has had no real media request for
  `PAUSE_KEEPALIVE_MAX_MS` (default 65 min; the clients' own cap is 60 min).

| response | meaning | client |
|---|---|---|
| `200 {ok, kept:true, sessions, transcoders}` | kept | keep going |
| `200 {ok, kept:false, reason:"no-session"\|"cap"}` | nothing to keep | stop |
| `410` (`Khouch-Displaced: 1`) | another device took the slot | stop |
| `400` | bad body / live | stop |

## Clients

Same rules on web (`public/pause-keepalive.js`), phone and TV
(`PauseKeepalive.kt` in `:core` and `:app`):

- Beat immediately on pause, then every 60 s.
- Stop after 60 min of continuous pause (then normal reaping applies), and on
  play, end of title, player close, app background / screen off (Android
  `ON_STOP`, web tab hidden) and cast hand-off.
- Foregrounded again while still paused: continue inside the original pause's
  60-min budget.
- Paused while backgrounded / hidden (focus loss, media key, notification):
  coming back while still paused starts a fresh keep-alive.
- Network errors: keep trying on the next interval. 401/403/404/405 stop it
  (signed out, or a server without the endpoint).
- A pause whose keep-alive ended itself (cap, displaced, rejected,
  no-session) is not restarted by a background / hidden round-trip.
- Web treats a hidden tab as backgrounded (owner rule: background stops the
  keep-alive), so a paused tab left hidden for > 3 min is reaped as before.

Test-only overrides: server `PAUSE_KEEPALIVE_MAX_MS`; web
`window.__khouchPauseKeepaliveMaxMs` / `__khouchPauseKeepaliveIntervalMs`
(set before `app.js` loads).

## VOD end check (related)

`lib/vod-end.js`: when a VOD ffmpeg exits, the position reached in the title is
`offsetSecs + playlistElapsedSecs(dir)` (a resumed transcode starts at its
`-ss` anchor). A trusted panel `duration_secs` (cached `get_vod_info`, or the
episode's info) decides alone: end at duration - 5 s. It is ignored when more
than 10% shorter than the TMDB runtime or over 2x it; then (or without one)
the end is TMDB runtime + 65 s (movies). Stream-copy runs add 10 s per anchored
seek (keyframe snap overstates the position). Reaching it marks the playlist ended and keeps the
dir for the viewer instead of respawning past EOF. A "no packets" respawn
right after a clean exit 0 is logged as `past end of file`, not `slot-held`.
