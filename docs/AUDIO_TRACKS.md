# Panel VOD audio tracks: server contract

Multi-audio panel movies/episodes (a 4K MKV with Tamil + Telugu + Hindi +
English tracks) get an Audio menu and a sensible default track.

## Where the track list comes from

Cached per title in `data/panel-tracks-cache.json` (`panelTracksCache`, key
`<mode>:<id>`, 7-day TTL). Entry: `{ audioTracks: [{ index, codec, channels,
lang, label, default }], ts }`. `index` is the audio-only ordinal, i.e.
ffmpeg `-map 0:a:<index>`, which is what `&at=<index>` selects.

Two sources, same shape:

1. **Learned from the transcoder (no extra connection).** The transcoder's
   ffmpeg runs with `-loglevel level+info -nostats`; its input stream dump
   (`Stream #0:3(hin): Audio: eac3, 48000 Hz, 5.1(side) ... (default)` plus
   `title :` metadata) is parsed by `lib/audio-tracks.js`
   (`createInputStreamParser`) and cached (`learnPanelTracks`, `source:
   "transcode"`). Only error-level lines go to the exit-tail diagnostics, so
   those read exactly as with `-loglevel error`. Learned under the stream id
   actually read (a failed-over alternate copy has its own layout).
2. **ffprobe (`runPanelTracksProbe`)** — a second provider connection, so it
   is refused while anyone on the account is streaming (cap=1 panel).

`GET /api/tracks/:mode/:id.:ext`: fresh cache -> returned. If this title has a
transcoder running or starting (or `/api/stream` for it was called < 20 s ago
and one appears within 4 s), the request waits up to 10 s for that ffmpeg's
dump instead of answering `busy` — clients ask once, so an empty answer meant
no Audio menu for the whole play. Otherwise the old ffprobe path (and its
`busy` answer while streaming).

Direct play (client reads the panel URL itself) is invisible to the server:
nothing is learned from it. The list then comes from a previous transcode, or
from the ffprobe when nobody is streaming.

## Which track plays (no explicit `&at=`)

`chooseAudioTrack(tracks, { originalLang, prefs })`:

1. The title's **original language**: TMDB `original_language` (movie:
   `movie:<id>`; series: `series:<series id>` from `/api/stream?series=`),
   else the stream name's language tag (`... (Hindi)`) / language-group tag.
   ISO 639-1 (`hi`, `pa`, ...), 639-2 (`hin`, `pan`, ...) and names (`Hindi`
   in a track title) all match. If no track has that language but some track
   is untagged (`und`/none), keep the file default (the untagged one may be
   the original; never jump to a known dub).
2. The profile's `audioLangPrefs` (user state, ISO 639-2 list; unset ->
   `["hin","eng"]`; settable via `PUT /api/user-state {audioLangPrefs: [...]}`,
   `null`/`[]` resets).
3. The file default (disposition `default`, else track 0).

Commentary / audio-description tracks (by title) are never auto-picked.
An explicit `&at=N` (Audio menu) always wins.

Applied in two places:

- `/api/stream` (cache known): the transcode URL carries `&at=<pick>`; the
  response's `audioTrack` field says which.
- First play of an unknown title, transcoded without `&at=`: when the dump
  arrives (~0.1-3 s, before the first 4 s segment), if the pick differs from
  the mapped track, that ffmpeg is killed and restarted ONCE on the right
  track (same key/dir, fresh playlist). Only if it is < 8 s old and nothing
  was written yet; otherwise the cache serves the next play. The restart is
  sequential (old connection closed first) and is treated as a slot-held
  retry if the panel still holds the slot — never two concurrent connections.
