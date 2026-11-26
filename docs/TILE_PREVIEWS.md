# Tile previews (TV)

When focus rests on a movie / series poster tile in a Home / Movies / Series
rail (2.5 s by default), the Khouch TV app expands it into a 16:9 card and
plays a preview with sound. Sources, in order:

1. The cached trailer clip: `GET /api/trailer/:key/preview.mp4?audio=1`.
2. A short preview of the title stream itself: `GET /api/preview/:mode/:id`.
3. A slow pan over the backdrop (client only).

## 1. Trailer clip with audio

`GET /api/trailer/:key/preview.mp4?audio=1` is the same ~30 s clip as the muted
preview (from 3 s in, video stream-copied, `moov` first, Range), plus the
trailer's first audio track as stereo AAC 128k. Stored as
`trailers/preview/<key>.a.mp4`; ETag `"<key>-pa-<size>"`. Access rules,
`404 not_cached` (with `Retry-After: 30`, queued for prefetch) and
`404 trailer_unavailable` are unchanged. Without `audio=1` nothing changes.

## 2. Stream preview (`GET /api/preview/:mode/:id`)

`mode` = `movie` | `series` (series: the panel series id; the server picks the
episode). Owner account only. `Cache-Control: no-store`.

```json
{ "sid": "p0f6ef5369cd07f55",
  "url": "/api/preview/p0f6ef5369cd07f55/index.m3u8?s=a709e20de869eabd",
  "mode": "movie", "id": 501, "series_id": null, "start": 600, "duration": 90 }
```

- `url`: a signed HLS playlist (no cookie needed, like `/api/transcode`): 854 px
  wide H.264 + stereo AAC, 2 s segments, `duration` seconds from `start`. Start
  playback at position 0 of the playlist (it has no end tag until the clip is
  fully encoded).
- `start`: the profile's resume point when it is a real one (past 60 s, before
  the last 10 %), else ~10 % in (60 s .. 15 min; 300 s when the length is
  unknown). Series: the profile's continue pointer (`lastEpisode`, which already
  moves to the next episode when one is finished), else S1E1.
- Errors: `409 {"error":"busy","reason"}` — `viewer` / `live-viewer` /
  `download` (someone is watching or downloading: clients back off 60 s),
  `provider` (the server is probing / downloading the guide / rebuilding the
  catalog), `play` (a real play started while this request waited),
  `preview` (another preview claimed the slot meanwhile); `403 not_allowed`
  (not the owner account, or a kid profile and the title's rating is not in
  its allowed certs; unrated = refused), `404` not in catalog, `429` (> 20 starts a
  minute per device), `503 disabled` (`TILE_STREAM_PREVIEW=0`) or
  `503 info_unavailable` (no series info).
- `POST /api/preview/stop {"sid"}`: stop it (focus left the tile). A stopped,
  replaced or preempted preview answers `410 {"error":"preview_stopped"}` on its
  playlist / segments.
- Nothing here writes watch history, progress, recents, last episode or For You
  signals.

### Priority on the one provider connection

A preview is the lowest-priority user of the household's single provider
connection (lib/stream-preview.js):

- **Admitted only when nobody is watching**: no live, non-displaced entry in the
  admission map (any viewer, Disk transcodes, phone downloads, a paused player
  kept alive by heartbeats), and no recent sign of a player on ANOTHER device:
  a VOD play request / progress post / pause heartbeat in the last 3 min, or a
  live play request whose session has not ended (live health report) within
  3 h (a progress post / heartbeat never shortens that hold). The asking
  device's own signals do not count. Nor while the server itself uses the
  provider (a liveness / codec probe, the xmltv download, a catalog rebuild).
  Checked before any panel call, and again right before ffmpeg starts.
- **Churn**: at most one new preview per 5 s (the request waits out the gap);
  software encodes use 2 threads; a title whose VAAPI decode fails is
  remembered (software next time).
- **Never displaces anything**, and is stopped (ffmpeg SIGKILLed, so its
  provider connection closes) by: any real `GET /api/stream` (any mode, any
  device; the request waits for that ffmpeg to exit before answering; a Disk
  play stops it but leaves no "watching" signal), any
  admission of a real owner (`/api/proxy`, `/api/transcode`; a phone download
  waits for the preview's ffmpeg to exit first),
  a progress post or pause heartbeat from another device, a new preview
  (one at a time; the old one's ffmpeg exits before the new one opens), an
  explicit stop, 20 s without a playlist / segment request while encoding, 60 s
  after the last request once encoded, or 4 min in total.
- **Save to Disk yields to it like to a viewer**: a running transfer is
  preempted when a preview starts (the preview opens only once the transfer's
  connection is gone), and jobs wait while it holds the slot.
- `GET /api/streams`: preview entries carry `preview: true`, are NOT counted in
  `active`, and are counted in a new top-level `preview`.

Logs: `[preview] <sid> start|stop (<reason>) ...`.
