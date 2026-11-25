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
transcoder running or starting, the request waits up to 10 s for that ffmpeg's
dump instead of answering `busy` (clients ask once, so an empty answer meant no
Audio menu for the whole play). No polling for a transcoder that may never
come (direct play): that keeps the old ffprobe / `busy` path. Response:
`{ audioTracks: [{ index, codec, channels, lang, label, default }],
currentTrack? }` — `currentTrack` = the track the newest running transcode of
this title maps (after a server auto-pick), so a client that hasn't chosen can
start its selection there. The cache also keeps `comment` / `visualImpaired`
disposition flags (both sources); they are not in the public shape.

Direct play (client reads the panel URL itself) is invisible to the server:
nothing is learned from it. The list then comes from a previous transcode, or
from the ffprobe when nobody is streaming.

## Which track plays

### URL contract

| param | who sets it | meaning |
|---|---|---|
| `at=N` | client (Audio menu) | explicit choice, **0 included**; always wins. Clients append it, so a repeated `at` takes the **last** value. |
| `ap=N` | server, in `/api/stream`'s `transcode` URL | the server's default pick (track list cached). Clients pass the URL through untouched. |
| neither | — | the running auto transcoder for these params, else a pick from the cache, else track 0 + learn-and-restart. |

`/api/stream` (movie/series) also returns `audioTrack`: the track its transcode
URL maps (explicit `at` passed to `/api/stream`, else the server pick, else 0).
Clients start their Audio selection from it and send `&at=k` only for an
explicit choice different from the current one. Transcoders are keyed by the
EFFECTIVE track (`-atN`), so key == what ffmpeg maps: an explicit `at=0` never
reuses a transcoder that auto-picked track 2.

### Default pick (`chooseAudioTrack`)

1. The copy's language: a stream NAME naming one language (`... (Hindi)`)
   wins — the Hindi copy of an English film plays Hindi. Untagged copies use
   the title's **original language** (TMDB `original_language`; series via
   `/api/stream?series=`), then the language-group tag. ISO 639-1 (`hi`),
   639-2 (`hin`) and names (`Hindi` in a track title) all match. If no track
   has that language but some track is untagged (`und`/none), keep the file
   default (the untagged one may be the original; never jump to a known dub).
2. The profile's `audioLangPrefs` (user state, ISO 639-2 list, settable via
   `PUT /api/user-state {audioLangPrefs: [...]}`, `null`/`[]` resets). Unset:
   the profile's onboarded languages (`filter.groups`), then `hin`, `eng`.
3. The file default (disposition `default`, else track 0).

Commentary / audio-description tracks (disposition `comment` /
`visual_impaired`, or by title) are never auto-picked. `/api/download` maps the
same default (cached list only).

### First play of an unknown title

Transcoded with no `at`/`ap`: when the dump arrives (~0.1-3 s, before the first
4 s segment), if the pick differs from track 0 the transcoder is re-keyed to
`...-atN`, its ffmpeg killed and restarted ONCE on track N (fresh dir). Only if
it is < 8 s old and nothing was written; otherwise the cache serves the next
play. The restart is sequential (old connection closed first) and is treated
as a slot-held retry if the panel still holds the slot — never two concurrent
connections. Player manifest polls stay on that transcoder via an auto alias
(base key -> actual key).
