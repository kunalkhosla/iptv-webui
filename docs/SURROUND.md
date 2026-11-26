# Surround sound: badges, rail, chip

Shows which titles carry real multichannel audio (5.1 / 7.1 / Atmos), a
"Surround sound" rail on the Movies and Disk homes, and a "Surround" filter
chip. Everything is additive; older clients ignore the new fields.

## Where the audio info comes from (never a stream)

| source | covers | how |
|---|---|---|
| `quality-cache.json` (`movie:<id>`) | panel movies | panel `get_vod_info` `info.audio` (the panel's own ffprobe): `audio_channels`, `audio_codec`, `audio_layout`, `audio_profile` |
| `panel-tracks-cache.json` | panel movies / episodes a viewer transcoded | tracks learned from the transcoder's input dump (docs/AUDIO_TRACKS.md); **wins** over the panel info when present |
| `series-audio.json` (`<series id>`) | panel series | max over the episodes of a `get_series_info` answer (detail/episodes requests, plus a boot seed from `info-cache/`) |
| `disk-probe-cache.json` | Disk library | local ffprobe of each file; only files in the current Disk index count |
| `audio-crawl-misses.json` (`movie:<id>` -> ms) | panel movies | `get_vod_info` carried neither video nor audio (panel never probed the file); not re-asked for 14 days |

Value = max channels over the title's tracks (a stereo Hindi + 5.1 English
file reads 5.1). Atmos only when a track title / panel profile says "Atmos"
(rare; TrueHD alone is not assumed to be Atmos).

All of it is owner-panel data (keyed by the owner's ids): member accounts on
other panels see no audio fields.

## API fields

Tiles (home rails, `/api/search/:mode`, `/api/search/all`,
`/api/similar`, `/api/collections/:id`, `/api/index/:mode`, `/api/:mode/item/:id`):

- `audio_channels`: int or null (unknown).
- `audio_codec`: ffprobe codec name (`eac3`, `truehd`, `dts`, ...) or null.
- `audio_format`: display label, only when known: `Atmos`, `TrueHD`, `DTS`,
  `DTS-HD MA`, `DTS-HD`, `DTS:X`, `E-AC3`, `AC3`, `AAC`, `FLAC`, `Opus`, `PCM`, ...
- `audio_badge`: `"5.1"` (6-7 ch), `"7.1"` (8+), `"Atmos"` (6+ and Atmos);
  omitted for stereo/mono/unknown. Clients show the badge exactly as given.
- tag `surround` in `tags` <=> `audio_badge` present (>= 6 channels; it used to
  mean >= 3).

Detail: `GET /api/poster/:mode/:id` (with TMDB configured) carries `audio_channels`,
`audio_codec`, `audio_format`, `audio_badge` (null = unknown). Series use the
series summary. `GET /api/episodes/:mode/:id`: each episode carries the same
four fields when known (omitted otherwise).

## Rail + chip

- `GET /api/home/movie` and `GET /api/home/disk`: rail `{ title: "Surround
  sound", category_id: "__rail-surround", total, items }` (up to 100) when >= 4
  titles qualify. Only confirmed >= 6 channels; one tile per TMDB id; no CAM /
  low-quality / hidden variants; the profile's title-language filter; kid
  profiles: the allow-list (`isKidSafe`, unrated hidden). Atmos then 7.1 first,
  then most-voted, lightly shuffled per visit. Disk titles stay in the Disk home
  (tile ids are per mode).
- Series: no rail (too little data). The `surround` chip still appears on the
  Series home when its tiles carry the tag.
- `chips` on `/api/home/:mode` now includes `{ key: "surround", label:
  "Surround", kind: "synthetic" }` whenever a tile in the rails carries the
  tag. Clients filter tiles by `tags.includes("surround")`.

## Crawler

`lib/surround.js createAudioCrawler`, started after each movie index build and
60 s after boot (owner panel only):

- one `get_vod_info` at a time, `SURROUND_CRAWL_INTERVAL_MS` apart (default
  4000), always against the owner panel; not cached in the 24 h memory cache;
  pauses (15 s polls) while anyone on the owner account is streaming;
  transient errors back off 60 s -> 15 min, an id failing 3 times on an otherwise
  healthy panel is skipped until restart; only a 404/410 counts as a miss. A degraded panel
  answer (auth reject, empty shell) is never recorded as a miss.
- quality-cache.json is saved at most once a minute from crawler writes.
- order: movie tiles a client was just shown without audio info (home rails
  incl. For You, per-mode search; newest first, max 2000 queued), then
  4K-tagged titles, then newest `added`.
- skips titles already known (`quality-cache` has `audio_channels`, including
  0 = panel probed the video but reported no audio; re-checked only when that
  entry is replaced) or a fresh miss. A full pass over the ~10k unknown titles takes ~12 h; then it idles and
  re-checks every 10 min / on a boost.
- The old burst prewarm (1500 calls per index build, concurrency 2) is gone; the
  4K verification pass now skips fresh misses.
- `SURROUND_CRAWL=0` disables it. `GET /api/admin/surround` (owner): crawler
  stats + coverage counts. Logs: `[surround] ...`.
