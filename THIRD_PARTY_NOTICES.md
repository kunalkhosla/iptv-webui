# Third-Party Notices

This project is MIT-licensed (see `LICENSE`) and depends on the following
third-party software and services. Their licenses and terms are summarized
below; consult the upstream projects for the authoritative text.

## Runtime dependencies (server)

- **Express** — MIT. https://github.com/expressjs/express
- **Node.js** (runtime) — MIT (with a small list of dependencies under their
  own permissive licenses). https://github.com/nodejs/node
- **ffmpeg** (invoked as a subprocess for transcoding; bundled in the
  published Docker image via Alpine's `ffmpeg` package) — LGPL/GPL depending
  on enabled components. The Alpine build links against `libx264` (GPLv2+)
  and other GPL'd encoders, so the published Docker image as a whole is
  effectively GPL-distributed. Source: https://ffmpeg.org/, Alpine package:
  https://pkgs.alpinelinux.org/package/edge/community/x86_64/ffmpeg

## Client dependencies (CDN-loaded, not redistributed by this repo)

- **hls.js** — Apache License 2.0. https://github.com/video-dev/hls.js
  Loaded from `cdn.jsdelivr.net` at runtime.
- **Google Cast Web Sender SDK** — Google APIs Terms of Service. Loaded from
  `www.gstatic.com` at runtime.
- **Bebas Neue**, **Karla** (typography) — SIL Open Font License 1.1. Served
  by Google Fonts; not bundled in this repo.

## External services

- **The Movie Database (TMDB)** — metadata and artwork are fetched at
  runtime via the TMDB API. Use of the TMDB API is subject to TMDB's terms
  (https://www.themoviedb.org/api-terms-of-use). Per those terms:

  > This product uses the TMDB API but is not endorsed or certified by TMDB.

  This notice is also shown in-app under the Settings menu.

  **If you fork and deploy this project yourself, register your own TMDB
  API key** at https://www.themoviedb.org/settings/api — it's free and
  takes a couple of minutes. TMDB keys are tied to individual accounts and
  the upstream repo's key is not shared. Set it as `TMDB_API_KEY` in your
  `.env`. Without a key the app still runs; it just falls back to whatever
  artwork the IPTV panel ships.

## Trademarks

"Khouch Potato" is a project name only; no trademark is claimed.
Netflix, Hulu, Disney+, Chromecast, TMDB, and other names mentioned in this
project are the property of their respective owners and are referenced
descriptively only.
