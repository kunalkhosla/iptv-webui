# Native trailers: server contract

Clients (web, Android phone, Android TV) play trailers in their own player.
They never open YouTube. The server downloads each trailer from YouTube once
and serves it as an mp4.

## 1. `GET /api/trailer/:key.mp4`

| | |
|---|---|
| `:key` | YouTube video key, from a tile's `trailer_key` or `/api/poster` `trailer_key`. Must match `^[A-Za-z0-9_-]{6,20}$`, else `400 {"error":"bad_key"}` |
| Auth | Normal session (cookie / Basic Auth, same as every other `/api` route). No signed URL. Unauthenticated: `401`. |
| Allowed keys | Only keys that are the `trailer_key` of a title in the TMDB cache. On a kid profile, at least one title with that trailer must be rated within the profile's allowed ratings. Any other key: `404 trailer_unavailable` at once, nothing downloaded. |
| Cached | `200` (or `206` for a `Range` request) immediately. `Content-Type: video/mp4`, `Accept-Ranges: bytes`, `Content-Length`, `ETag` (stable: `"<key>-<size>"`, so `If-Range` / `If-None-Match` work), `Cache-Control: private, max-age=86400`. |
| `HEAD` | Answers from the cache only: `200` with headers if cached, else `404`. Never starts a download. |
| Not cached | The response waits while the server downloads the trailer (typically 10-15 s, at most ~45 s), then it is served as above. Concurrent requests for the same key share the one download. |
| Unavailable | `404 {"error":"trailer_unavailable"}` (`Cache-Control: no-store`). Video removed, region-blocked, yt-dlp broken, timeout. The failure is remembered for 6 h (15 min for a timeout), during which the same key answers `404` immediately. All remembered failures are forgotten when yt-dlp is updated. |

File format: mp4 with H.264 video up to 720p and AAC audio, `moov` atom at
the start (playback can begin before the whole file arrives). Typical size
5-15 MB for a 2-3 min trailer. If YouTube offers no 720p H.264 stream, the
fallback is the best single mp4 up to 720p (often 360p).

### Client notes
- **Read timeout:** an uncached trailer sends no bytes until the download
  finishes. Use a read/connect timeout of at least 50 s for this URL (ExoPlayer
  / OkHttp default to 8-10 s). Show a spinner; treat `404` as "no trailer"
  (hide or fall back to YouTube).
- Seeking uses normal HTTP Range requests.
- Do not retry a `404` in a loop: the server keeps answering `404` until the failure memory expires.

## 2. TMDB cache fields

Each TMDB cache entry (`data/tmdb-cache.json`, and `/api/poster/...` responses)
now carries:

- `release_date`: `YYYY-MM-DD` (movie `release_date`, series `first_air_date`) or `null`.
- `trailer_key`: YouTube key or `null` (already existed).

New entries get both from the normal detail fetch. Older entries are filled
by a background backfill (`backfillReleaseDates`): library titles from this
year or last year only, one TMDB call per title with a 250 ms gap, at most 1500
per run, 5 min after boot and every 6 h. Recent titles still without a trailer
are rechecked weekly. Owner can start it: `POST /api/admin/backfill-release-dates`.

## 3. Home rail "New trailers"

In `GET /api/home/movie` and `GET /api/home/series` (not live, not disk):

```json
{
  "title": "New trailers",
  "category_id": "__rail-new-trailers",
  "total": 23,
  "items": [ /* up to 40 tiles */ ]
}
```

- Items: library titles whose `release_date` is within the last 120 days
  (movies) or 90 days (series, first air date), not in the future, with a
  `trailer_key`. Newest release first. One tile per `tmdb_id` (4K / FHD
  copies collapse).
- Same gates as Recently Added: title language, one variant per title,
  camera copies excluded, kid profiles only get titles with an allowed
  rating.
- The rail is left out when empty. It sits right after "Recently Added".
- Tile shape = the normal home tile plus two fields (older clients ignore
  them):

```json
{
  "id": 12345, "name": "…", "icon": "…", "year": "2026",
  "poster": "https://image.tmdb.org/t/p/w342/…", "us_cert": "PG-13",
  "tags": ["…"], "container": "mkv", "audio_channels": null, "audio_codec": null,
  "trailer_key": "Way9Dexny3w",
  "release_date": "2026-11-18"
}
```

Play the trailer with `/api/trailer/<trailer_key>.mp4`; the tile `id` still
opens the title's detail page as usual.

## Server behaviour

- Cache dir `DATA_DIR/trailers/<key>.mp4`. Writes go to `trailers/.tmp/` and
  are renamed into place; leftovers are cleared at boot.
- At most 2 downloads at once. A viewer's request goes ahead of queued
  background downloads.
- Background prefetch: when a home payload with the rail is built, the first
  12 trailers are queued (max 40 queued). One download at a time, 5 s apart,
  waiting while anyone is streaming or a viewer-triggered trailer download
  runs; 5 failures in a row pause it for 10 min.
- Eviction (boot + every 6 h + after each download): delete files not served
  for 30 days, then the least recently served until the total is under
  `TRAILER_CACHE_MAX_GB` (default 8).
- yt-dlp: pinned in the Dockerfile (standalone musl build, sha256-checked),
  YouTube JS challenges solved with the image's node (`--js-runtimes node`).
  The server keeps `data/bin/yt-dlp` updated with `yt-dlp -U` (weekly,
  tracked by the stamp file `data/bin/.yt-dlp-updated` so redeploys don't
  postpone it; and after 3 failed downloads in a row, at most every 12 h) and
  uses the newer of the two binaries. yt-dlp runs with a minimal environment
  (PATH, HOME, LANG, XDG_CACHE_HOME), never the server's secrets.
- A download that never finishes gives its slot back 15 s after the 45 s
  timeout.
- Trailers talk to YouTube only. They never open an IPTV panel connection
  and do not count toward the panel's 1-stream limit.
- Owner diagnostics: `GET /api/admin/trailers`.
