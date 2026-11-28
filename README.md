<p align="center">
  <img src="docs/banner.svg" alt="Khouch Potato" width="100%">
</p>

# Khouch Potato

A self-hosted web UI for an Xtream Codes IPTV panel — built because every
reseller's mobile / TV app is awful. Browse 10k+ live channels, movies, and
series with instant search, Netflix-style rails, a Live TV Guide, and
Chromecast support. Companion native Android TV app (`iptv-android-tv`)
talks to the same backend.

## What you get

- **Live**, **Movies**, **Series** modes — one URL, one login, no Android junk
- **TV Guide** — full-week EPG laid out on a time grid with a live now-line,
  filterable in place by language / 4K / Movies / Sports / News / Music / Kids
- **Netflix-style home** on Movies / Series — hero billboard, Continue
  Watching, My List, Favorites, Recents, plus a rail per category; the same
  chip strip filters the whole home view
- **Multi-user with per-user panel credentials** — the owner invites
  friends via single-use signup links (Settings → Profile → Invite a
  friend…). Each user brings their own IPTV-panel login, kept
  AES-256-GCM-sealed on disk; nobody sees anyone else's creds, profiles,
  catalog, or Continue Watching
- **Multi-profile per user** — within a single login, separate
  favorites / recents / watched / progress per profile, sync across the
  web client and the Android TV app on the same profile automatically.
  Header chip shows the active profile and opens a click-to-switch
  popup from any screen
- **Kids profile** with TMDB-cert age gating (no Squid Game for 6-year-olds)
- **TMDB enrichment** — posters, backdrops, plots, ratings, runtimes, episode
  stills. Cache pre-warms on boot so tiles are populated immediately
- **Server-side stream signing** — Chrome's `<video>` element can't carry
  HTTP Basic Auth on segment fetches, so the proxy and transcoder use HMAC
  signatures generated behind the gated `/api/stream` endpoint
- **ffmpeg transcoder** for the fraction of channels with codecs the browser
  can't decode in MSE (mostly MPEG-2 SD)
- **Chromecast Web Sender** — Cast sends the panel URL directly to the
  Chromecast (no proxy round-trip) so quality survives the cast
- **Single source of truth for channel groups** — the server pre-tags each
  stream with language / country / genre tags at index-build time; clients
  do O(1) Set lookups on chip toggles instead of running regexes per channel

## Screenshots

### Live TV
<img width="1908" height="999" alt="image" src="https://github.com/user-attachments/assets/4f96d620-5486-438b-b4c1-83670c2576bd" />

### Movies
<img width="1914" height="999" alt="image" src="https://github.com/user-attachments/assets/dd534d19-d93a-4bc0-9af5-0328100b05d8" />

### TV Show
<img width="1907" height="1003" alt="image" src="https://github.com/user-attachments/assets/54d16df3-6227-46ba-9813-cb2b4a7f89ea" />

## Configuration

Copy `.env.example` to `.env` and fill in:

```
IPTV_HOST=http://your-panel.example
IPTV_USER=...
IPTV_PASS=...
APP_USER=admin
APP_PASS=...                  # seeds the owner account on first boot (see below)
TMDB_API_KEY=...              # YOUR OWN key — register at themoviedb.org (free, ~2 min). Optional but strongly recommended.
PROXY_SECRET=...              # strongly recommended; required once you invite a second user
IPTV_HOST_FALLBACK=http://backup-panel.example   # optional secondary panel
HA_URL=http://homeassistant.local:8123            # optional: programme-reminder pushes via Home Assistant
HA_TOKEN=...                                       # optional: HA long-lived token
HA_NOTIFY_SERVICE=mobile_app_your_phone            # optional: owner household default notify service
HA_NOTIFY_PROFILES=Alice=mobile_app_alice,Bob=mobile_app_bob   # optional: per owner-user profile notify service
```

`IPTV_*` and `APP_*` are used ONLY on first boot to seed the owner
user in `data/accounts.json`. After that:

- The owner's panel credentials live in (AES-256-GCM-encrypted)
  `data/panel-config.json` and are editable in Settings → Edit panel
  credentials.
- The owner's password is the scrypt hash stored in `data/accounts.json`;
  changing `APP_PASS` in env afterwards has no effect.
- Additional users self-register via owner-issued invite links — they
  bring their own panel credentials and never see yours.

`PROXY_SECRET` is the AES-GCM key derivation source for sealed account
credentials. Keep it stable across restarts; rotating it makes every
non-owner user's sealed creds unreadable.

## MCP endpoint (assistants)

`POST /mcp` is a minimal, stateless [MCP](https://modelcontextprotocol.io)
server (Streamable HTTP, JSON responses, no sessions) so an assistant can
drive Khouch. Enable it with:

```
MCP_TOKENS=alice/p1=<token>      # username[/profileId]=token, comma-separated
MCP_PUBLIC_URL=https://iptv.example.com
```

- **Auth:** `Authorization: Bearer <token>` only — cookies and Basic Auth are
  refused on `/mcp`. Each token acts as one user + profile, so that
  profile's kids/language filters and Continue Watching apply. Tokens are
  held as SHA-256 digests and compared in constant time; rotate by editing
  the env and restarting.
- **Tools:** `search` (catalog → opaque `ref`s), `whats_on` (now/next for
  matching channels, plus programmes whose title matches, e.g. a team name),
  `continue_watching` (saved positions), `resolve_playback` (ref → cast-ready
  URL + resume position; for a series picks the last-watched or a given
  S/E episode).
- **Khouch never casts or opens a stream here.** `resolve_playback` only
  builds the URL (the same one `/api/stream` gives every client); the stream
  opens when the caller's media player (e.g. Home Assistant
  `media_player.play_media`) fetches it. Mind your panel's concurrent-stream
  limit.
- Read tools reuse the real HTTP handlers via a loopback request as the
  token's user, so results match what the web UI shows.

## Live stream URLs (`/api/stream/live/:id.m3u8`)

- Liveness is checked with one playlist GET (no segments) when the cached
  verdict is older than 30 min; persistent failures (404/410/empty playlist)
  answer `503 channel_unavailable`. Checks and probes are skipped while
  another viewer streams (the panel allows one connection).
- `liveChecked: true` means the server's liveness verdict is current, so a
  client may skip its own pre-play manifest check.
- `?probe=0` (implied for the Android apps' okhttp user agent): the client
  picks direct vs transcode itself and never reads `forceTranscode`/`url`, so
  the server skips the audio-codec ffprobe.
- Each call logs one `[zap]` line with total, check and probe timings.

## Title variants (language / quality copies)

Movie/series search (`/api/search/:mode`; `/api/search/all` only with `?group=1`) returns one tile per title. The tile is the original-language, best-quality copy and adds `langName`, `langGuess`, `quality`, `variantCount` and `variants[]` (every copy the profile may see). `GET /api/variants/:mode/:id` returns the same list for any copy, for a detail-screen "Watch in" picker. Kid-safe. See [docs/VARIANTS.md](docs/VARIANTS.md).

## Title logos

TMDB title-logo art is cached per title and exposed as `logo` (full w500 PNG URL or `null`) on `/api/poster/:mode/:id` and on home `hero[]` items. See [docs/TITLE_LOGOS.md](docs/TITLE_LOGOS.md).

## Audio tracks (`/api/tracks/:mode/:id.:ext`)

Multi-audio panel VOD: the track list is learned from the transcoder's own ffmpeg (no extra provider connection on a cap=1 account) or an idle-time ffprobe, and a fresh play defaults to the title's original language, then the profile's `audioLangPrefs` (default `hin`, `eng`), then the file default; `&at=N` overrides. See [docs/AUDIO_TRACKS.md](docs/AUDIO_TRACKS.md).

## Scrub thumbnails, skip intro / credits, collections, episode progress

`/api/trickplay/:mode/:id` (seek-bar preview frames), `/api/markers/:mode/:id`
(intro / credits times from audio fingerprints), `/api/trailer/:key/preview.mp4`
(muted 30 s preview), `/api/collections` + `/api/collections/:id` (TMDB
collections in release order, also `collections` on the movie home payload),
`/api/episodes/:mode/:id` (episode stills + per-profile progress). Built only
from transcodes a viewer is already running and from Disk-library files, never
from an extra panel stream, so coverage is partial. Contract:
[docs/NETFLIX_FEATURES.md](docs/NETFLIX_FEATURES.md).

## Live buffering rescue

Clients report each live session's stalls, reconnects and time to first frame
(`POST /api/live/health/:id`); the server keeps a per-copy health score by hour
of day. When a channel struggles, `GET /api/live/alternates/:id` lists the other
copies of the same channel (same region prefix, so `UK: ZEE TV` is never offered
for `IN: ZEE TV`) ranked by that score, and the client switches to the best one
with a 10 s undo. No synthetic probing. See [docs/LIVE_RESCUE.md](docs/LIVE_RESCUE.md).

## Programme reminders

"Remind me" on a future guide programme (`/api/reminders`, per profile). Two
minutes before start the server pushes a Home Assistant notification (when
`HA_URL`/`HA_TOKEN` are set) and open clients show a banner. A reminder never
opens a stream. See [docs/REMINDERS.md](docs/REMINDERS.md).

## New episodes and Notify me

Series a profile follows get a "New episode" badge and a "New episodes" home
rail when the panel adds episodes (polled every 6 h, API calls only, paused
while anyone watches). "Notify me" on a TMDB title the catalog lacks (search
and cast pages show them as "Not on Khouch yet") pushes a Home Assistant
notification and fills a "Now on Khouch" rail once it arrives. One title can be
removed from Continue Watching on every client. See
[docs/NEW_EPISODES_AND_NOTIFY.md](docs/NEW_EPISODES_AND_NOTIFY.md).

## Pause keep-alive

A paused movie / episode / disk title makes no media requests, so the idle
reaper would free its session after ~3 min. While paused, clients send
`POST /api/stream/heartbeat` `{ mode, id }` every minute (max 60 min; never for
live) and the server refreshes the caller's existing session only. See
[docs/PAUSE_KEEPALIVE.md](docs/PAUSE_KEEPALIVE.md).

## Tile previews (TV)

A focused poster tile on the TV expands and plays the cached trailer clip with
sound (`/api/trailer/:key/preview.mp4?audio=1`), else a 90 s preview of the
title stream (`GET /api/preview/:mode/:id`): the lowest-priority user of the
provider connection, admitted only while nobody is watching and stopped by any
real play. See [docs/TILE_PREVIEWS.md](docs/TILE_PREVIEWS.md).

## Native trailers (`/api/trailer/:key.mp4`)

Trailers play inside the apps instead of opening YouTube. Details and the
full client contract: [docs/TRAILERS.md](docs/TRAILERS.md).

- `GET /api/trailer/<youtubeKey>.mp4` (normal session auth): served from
  `data/trailers/` with HTTP Range; on a miss the server downloads it first
  with yt-dlp (720p H.264/AAC mp4, ~10 MB, ~10-15 s), then serves it. Only
  keys that are a cached title's TMDB `trailer_key` are accepted (kid profiles:
  a title within their ratings); `HEAD` never downloads. Failure:
  `404 {"error":"trailer_unavailable"}`, remembered for 6 h (timeouts 15 min,
  cleared when yt-dlp updates).
- Cache: max 2 downloads at once (viewer requests before background ones),
  same-key requests share one download, files unused for 30 days are
  deleted, total capped at `TRAILER_CACHE_MAX_GB` (default 8).
- Home rail **New trailers** (`category_id: "__rail-new-trailers"`, movies and
  series): library titles released in the last 120 days (series: first aired
  in the last 90), newest first; tiles add `trailer_key` and `release_date`.
  The top of the rail is downloaded in the background, one at a time, only
  while nobody is watching.
- yt-dlp is pinned in the Dockerfile (`YTDLP_VERSION` + sha256). The server
  keeps a self-updated copy in `data/bin/yt-dlp` (`yt-dlp -U` weekly, by a stamp
  file on the data volume, and after
  3 failures in a row, at most every 12 h) and uses whichever is newer.
  `YTDLP_BIN` overrides the image path.
- This talks to YouTube only; it never opens an IPTV panel connection.
- Owner: `GET /api/admin/trailers` (yt-dlp version, cache/prefetch stats),
  `POST /api/admin/backfill-release-dates`.

## Running locally

```
npm install
node --env-file=.env server.js
```

Open http://localhost:3737.

The first request to `/api/bootstrap` is slow (the indexer scrapes ~600
categories total). Subsequent requests are served from the in-memory
cache. The cache TTL is 1 hour with a background refresh.

A background TMDB pre-warm fires after each index build (and at boot when
indexes are already fresh), so by the time you load Movies / Series, the
posters are already cached.

## Deploying

A GitHub Action builds and pushes `ghcr.io/<owner>/iptv-webui:latest`
AND auto-deploys to the VPS on every push to `main` — pushing to `main`
*is* the deploy step. Within ~2-3 minutes the new image is live.
Traefik fronts the container and handles Let's Encrypt automatically.

## Android TV companion

A separate repo, **[`iptv-android-companion`](https://github.com/kunalkhosla/iptv-android-companion)**
(Kotlin + Compose for TV + ExoPlayer), is a thin native client of this
server. Auth, profiles, state, transcoding, TMDB enrichment, and
concurrency safety all live here — the TV app just calls `/api/*`. The
same cookie session works across both, so favorites / progress sync
automatically.

## Architecture

```
Browser / TV ──HTTPS──► Traefik ──HTTP──► Express (server.js)
                                              │
                                              ├── /api/bootstrap          (panel metadata, auth-gated)
                                              ├── /api/index/{mode}       (full catalog incl. pre-computed tags)
                                              ├── /api/home/{mode}        (server-built rails + hero)
                                              ├── /api/search/{mode}      (substring search)
                                              ├── /api/epg/short/{id}     (EPG window for one channel)
                                              ├── /api/poster/{mode}/{id} (TMDB enrichment)
                                              ├── /api/trailer/{key}.mp4  (YouTube trailer via yt-dlp, cached on disk)
                                              ├── /api/stream/{mode}/{id} (returns SIGNED proxy + transcode URLs)
                                              ├── /api/proxy?u=…&s=…      (HMAC-signed; bypasses Basic Auth)
                                              └── /api/transcode/...      (ffmpeg → /tmp/iptv-transcode/)

Stream data flow:
  Browser  ──► /api/proxy ──► panel ──► segments back through Express  (or)
  Browser  ──► /api/transcode ──► ffmpeg ──► segments out of /tmp     (or)
  Chromecast / TV ──► panel directly                                  (Cast bypasses proxy)
```

Server only proxies metadata and segments. Cast traffic goes panel →
Chromecast directly.

## Caveats

- HLS playback in browsers uses hls.js (Chrome/Edge/Firefox); Safari uses
  native HLS.
- Most panels enforce `max_connections=1` per IPTV account — if the TV's
  IPTV app is also running, the cast / web play will fail or knock the TV
  off. This is panel-side, not us.
- This project assumes you have a legitimate subscription to whatever panel
  you point it at. It is just a UI; it does not bypass any DRM or auth.

## Phone downloads (status fields)

`POST /api/download/prepare/:mode/:id`, then poll `GET /api/download/status/:mode/:id`.
Fields: `state` (`none|queued|waiting|running|ready|failed`), `pct`, `stage`
(`queued|fetching|waiting-for-viewer|encoding`), `bytes`, `error`, `queue_position`,
and `waiting_for: "viewer"` (additive; present when the job, or the running job it is
queued behind, is paused because someone is watching on the same provider account).
The 24h cap runs from when a job starts; a job queued for over 3 days fails with a
clear error. Jobs are in memory: after a server restart `state` is `none` and the
phone re-prepares.
