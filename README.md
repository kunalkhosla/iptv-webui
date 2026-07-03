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
