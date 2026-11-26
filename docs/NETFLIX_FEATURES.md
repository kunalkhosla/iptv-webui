# Netflix-style features: server contract

Server side of: scrub thumbnails, skip intro / credits, trailer previews,
collections, episode stills + progress, reliable posters. Every field below
is additive: older clients ignore it. All routes need the normal session
(cookie or Basic auth) like every other `/api` route.

## Hard rule: no upstream streams

The IPTV panel allows ONE stream for the whole household. Nothing here opens
or probes a panel stream. Thumbnails and audio fingerprints come only from:

- **Piggyback**: the HLS segments a viewer's own VOD transcode
  (`/api/transcode/...`) already wrote to local disk. A small low-priority
  ffmpeg (nice 19, 1 thread, one at a time, paused when the load average is
  high) reads those local files. Owner account only.
- **Offline**: Disk-library files (local drive), one job at a time, only
  while nobody is watching anything; a running job is killed the moment a
  viewer starts and retried later.

So coverage is partial by design: titles that were direct-played (no
transcode) have no thumbnails/markers until they are watched through the
transcoder; a transcode that started mid-title covers only what it encoded.
Clients must handle "none".

## 1. Trick-play thumbnails

`GET /api/trickplay/:mode/:id` (`mode` = `movie` | `series` | `disk`; `id` =
movie stream id, series **episode** id, or disk file id)

```json
{
  "mode": "series", "id": "123456",
  "interval": 10,
  "width": 240, "height": 136,
  "complete": false,
  "count": 3,
  "frames": [0, 12, 24],
  "url": "/api/trickplay/series/123456/{t}.jpg"
}
```

- `frames`: seconds (integers, ascending) that have a JPEG. Spacing is
  nominally `interval` but irregular (segment / keyframe aligned; gaps where
  nothing was encoded). Pick the largest `t <= position` (or the nearest).
- `count: 0` / `frames: []` = none: hide the preview, keep the plain seek bar.
- `complete: true` only after a full offline pass (Disk library).
- `width`/`height` are the real frame size (240 px wide, aspect kept), or null.
- The list grows while a transcode runs: re-fetch at most every 15-30 s
  (response is `Cache-Control: private, max-age=15`).

`GET /api/trickplay/:mode/:id/:t.jpg` -> `image/jpeg`
(`Cache-Control: private, max-age=604800, immutable`), or `404 {"error":"no_frame"}`.

Storage: `DATA_DIR/trickplay/<mode>-<id>/<t>.jpg`, LRU-evicted by title:
partial (piggyback) titles above `TRICKPLAY_CACHE_MAX_MB` (default 2048),
complete Disk-library titles above `TRICKPLAY_DISK_MAX_MB` (default 8192; an
evicted one is not regenerated).

## 2. Skip intro / credits markers

`GET /api/markers/:mode/:id` (same ids as above)

```json
{
  "mode": "series", "id": "123456",
  "introStart": 96.4, "introEnd": 127.8,
  "recapStart": null, "recapEnd": null,
  "creditsStart": 3034.3,
  "source": "fingerprint",
  "support": { "intro": 3, "credits": 1 },
  "analysed": { "head": true, "tail": true }
}
```

- Seconds from the start of the title. Any field may be `null` = not known or
  not sure: show no button for it.
- **Recap is not detected** (always null).
- **Movies**: always null (no reliable signal; a TMDB/runtime guess is never
  used as a skip target).
- Detection: audio fingerprints (lib/fingerprint.js, Philips-style 32-bit
  sub-fingerprints of 300-2000 Hz band energies) of the first 10 min (intro)
  and last 8 min (credits) of each episode, compared with other episodes of
  the same series (same season first). Intro = the longest shared stretch
  (12-150 s) in the first 10 min; credits = a shared stretch that runs to
  within 45 s of the end in both episodes, in the second half. A marker backed
  by one comparison needs a clean match (bit error rate <= 0.25); two or more
  agreeing comparisons are trusted. Validated on Fauda S5 (intro 27-31 s after
  a cold open of varying length; credits ~70 s).
- Needs >= 2 analysed episodes of the same series. Markers appear as a
  transcode passes the 10 min mark (head) or reaches the end (tail). A client
  that got nulls with `analysed.head: false` may re-fetch once after ~2 min of
  playback (`Cache-Control: private, max-age=60`).
- `support` = number of agreeing comparisons.
- Auto-next from credits: start the next episode at `creditsStart` (client).

Storage: `DATA_DIR/markers/index.json` + `markers/fp/<mode>-<id>.json`.

## 3. Trailer previews

- `GET /api/trailer/:key/preview.mp4`: muted ~30 s clip of the CACHED trailer
  (from 3 s in, video only, stream copy, `moov` first, Range requests, ETag
  `"<key>-p-<size>"`, `Cache-Control: private, max-age=86400`). Same access
  rule as `/api/trailer/:key.mp4` (TMDB trailer of a cached title; kid
  profiles: a title within their allowed ratings).
  - Trailer not downloaded yet: `404 {"error":"not_cached"}` with
    `Retry-After: 30` immediately (never waits for a download); it is queued
    for the background prefetch. Retry later, not in a loop.
  - `404 {"error":"trailer_unavailable"}`: no trailer / not allowed.
- Home tiles (`/api/home/movie|series` rails, `tileFor`) now carry
  `trailer_key` when the title has one (omitted otherwise). Hero items carry
  `trailer_key` and `preview` (the preview URL). The hero's first 4 trailers
  are queued for background download on each home build.
- Detail (`GET /api/poster/:mode/:id`) adds
  `trailer: { key, url, preview, cached } | null` (`cached` = full trailer on
  disk, so `preview` will answer at once).

## 4. Collections

- `GET /api/collections?mode=movie&limit=200` (movie only; any other mode ->
  empty list):

```json
{ "title": "Collections", "total": 1235, "items": [
  { "id": 1241, "name": "Harry Potter Collection",
    "poster": "https://image.tmdb.org/t/p/w342/...", "backdrop": "https://image.tmdb.org/t/p/w1280/...",
    "count": 8, "first_year": 2001, "last_year": 2011 } ] }
```

  Only collections with >= 2 titles visible to this profile. Order: ones the
  profile has played from first, then 3+ titles, then popularity.
- `GET /api/collections/:id`: the tile fields above plus `overview` (TMDB, may
  be null) and `items` (one tile per title, release order):
  `{ id, name, icon, poster, year, release_date, rating, us_cert, tmdb_id,
  category_id, tags, container, trailer_key }`. `404` when nothing is visible.
- Gate (per profile): title language (onboarding), kid ratings (unrated =
  hidden for kids), no camera copies, one variant per title (canonical first).
- `GET /api/home/movie` adds a top-level `collections` object (same shape as
  `/api/collections`, max 30 items). Its tiles are COLLECTIONS, not titles:
  open `/api/collections/:id`. It is NOT in `rails`, so old clients never see
  collection tiles.
- Detail (`GET /api/poster/movie/:id`) `collection` keeps
  `{id, name, poster_path, backdrop_path}` and adds `poster`, `backdrop`,
  `count` (titles visible to this profile) and `url`
  (`/api/collections/:id`, or null when fewer than 2).
- The existing franchise rails (3+ titles) and `/api/similar` collection rail
  are unchanged.

## 6. Episodes: stills + per-episode progress

`GET /api/episodes/:mode/:id` (`series` = panel series id, `disk` = disk
series-group id, owner only). `Cache-Control: no-store`.

```json
{ "id": 1234, "mode": "series", "tmdb_id": 69557,
  "seasons": [ { "season": 1, "episodes": [
    { "id": "998877", "episode_num": 1, "title": "...", "plot": "...", "air_date": "2015-02-16",
      "duration_secs": 2673, "container": "mkv",
      "still": "https://image.tmdb.org/t/p/w400/....jpg",
      "progress": { "position": 1200, "duration": 2673, "pct": 45, "updated_at": 1790000000000 },
      "watched": false } ] } ],
  "last_episode": { "episode_id": "998877", "season": 1, "episode_num": 1 } }
```

- `still`: TMDB still (w400), else an https panel image, else null.
- `progress`: this profile's saved position (null when not started or
  finished; finished episodes drop their progress server-side), `watched`:
  in the profile's `watched` list.
- `/api/series/info/:id` and `/api/poster/series/:id/season/:n` are unchanged
  (the latter's cache is kept warm by this endpoint).
- Panel down: served from the last good series info on disk; none at all ->
  `503 {"error":"info_unavailable"}`.

## 7. Posters

Every VOD tile `poster` (home rails + hero, search, similar, person credits,
refine, language collection, collections) now resolves:

1. the TMDB poster;
2. a panel icon that is itself a TMDB image (re-sized to w342);
3. any other **https** panel icon;
4. `null`.

Never `http:` (mixed content on the web), never `data:`, never initials. Live
channels keep `poster: null` (their `icon` is a logo). A VOD tile whose title
has no TMDB cache entry queues a background TMDB lookup (one at a time,
400 ms apart, retried at most every 6 h per title), so its poster appears on
a later load. With `poster: null`, clients draw a generated title card.

## Ops

- `GET /api/admin/sidecar` (owner): queue/tracking stats + marker counts.
- `MEDIA_SIDECAR=0` turns the sidecar off. `TRICKPLAY_CACHE_MAX_MB`, `TRICKPLAY_DISK_MAX_MB`.
- Offline jobs yield to any viewer: panel streams, transcodes, and open
  `/api/diskfile` direct-play responses (plus 2 min after the last one).
- Fingerprints are kept for at most 3000 episodes (oldest dropped; their
  markers stay).
  `MEDIA_SIDECAR_DISK_DELAY_MS` (first Disk-library pass after boot, default 10 min).
- Logs: `[sidecar] ...`.
