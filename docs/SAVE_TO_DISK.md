# Save to Disk

Owner-only: queue a highest-quality copy (stream copy, no re-encode) of an
IPTV movie or of series episodes onto the server's Disk library
(`<disk root>/Downloads/`). Web: the detail page's Disk menu. Android phone:
"Save to home server (Disk)" on movie / series detail (owner account, adult
profile). Not the phone's offline 720p "Download".

## Scheduling

The provider allows ONE stream for the whole household, so jobs run one at a
time and only while nobody is watching:

- **Starts now.** A queued job starts as soon as no viewer holds the stream
  slot and none has been seen for the resume grace.
- **Yields immediately.** Any play request (`GET /api/stream/<mode>/...`,
  except Disk titles, which are local files) stops the running transfer's
  provider connection synchronously, before the player's own first upstream
  request; the viewer is admitted normally (no 410, no extra wait). Measured
  locally: the download's connection closes ~50 ms into the play request,
  before the viewer's first upstream byte request. A player that skips
  `/api/stream` (e.g. a re-anchor straight to `/api/transcode`) still evicts
  the transfer through admitStream's oldest-evicted rule.
- **Resumes on its own** (HTTP Range from the `.part` file, never from zero)
  once the slot is free and no viewer activity was seen for
  `DISK_DOWNLOAD_RESUME_GRACE_MS` (default 120000). A viewer's slot is held
  while it is playing, buffering, or paused with keep-alive heartbeats
  (`docs/PAUSE_KEEPALIVE.md`), and freed by the idle reaper
  (`LIVE_IDLE_GRACE_MS`, 180 s on hestia), so in practice a job resumes about
  2-3 min after the last viewer stops.
- **Restart-safe.** Jobs persist in `data/disk-download-jobs.json`; after a
  restart, queued/downloading/paused jobs come back as queued and resume via
  Range after the grace (players that were watching get to reconnect first).
- **Disk space.** A job fails with `disk almost full ...` when the Disk root
  has < 5 GB free, or less than the remaining bytes + 5 GB once the size is
  known. The `.part` is kept (re-queueing the same title resumes it).
- **Background, not a viewer.** A transfer never makes the idle reaper touch a
  viewer, never counts as "watching" for TARS `now_streaming` or the media
  sidecar, and is excluded from `GET /api/streams` `active` (listed with
  `background: true`; top-level `background` = their count). Background panel
  work (catalog rebuild, surround crawl, detail prewarm) still yields to it,
  since it holds the provider connection.

**Optional overnight window (opt-in).** Set BOTH
`DISK_DOWNLOAD_WINDOW_START_HOUR` and `DISK_DOWNLOAD_WINDOW_END_HOUR` (0-23,
different; may wrap midnight; hours in `DISK_DOWNLOAD_WINDOW_TZ`, default
America/New_York) to only start jobs inside that window. One var alone or a
bad value is ignored (logged) and there is no window.

Logic: `lib/disk-download-schedule.js` (pure, tested), runner in `server.js`
(`processDiskDownloadQueue` / `runDiskDownloadJob`).

## API

`POST /api/disk-download`

```json
{ "mode": "movie", "id": 123, "title": "Up", "year": "2009" }
{ "mode": "series", "episodes": [{ "id": "456", "seriesTitle": "Show", "season": 1, "episodeNum": 2, "episodeTitle": "Two", "year": "2020" }] }
```

-> `{ ok: true, jobIds: [...], jobs: [job...], window }`;
`400 { ok: false, error }` (`disk not configured`, `invalid movie id`,
`no valid episodes`, `mode must be movie or series`); `403 { error: "owner only" }`.
No dedupe: the client must not re-queue a title that is queued, running or done.

`GET /api/disk-download/jobs` -> `{ jobs: [job...newest first], window }`: every
queued/downloading/paused job plus the newest 100 done/failed.
`GET /api/disk-download/jobs?mode=series&ids=1,2,3` -> every job for just those
source ids, uncapped (a detail page asking about its own titles). Done/failed
history is kept for the newest 200 jobs only.

job:

| field | meaning |
|---|---|
| `id` | job id (`jobIds` entry) |
| `mode`, `sourceId` | `movie` + stream id, or `series` + episode id |
| `status` | `queued` / `downloading` / `paused` / `done` / `failed` |
| `title`, `seriesTitle`, `season`, `episodeNum` | display |
| `bytesWritten`, `totalBytes` | progress; `totalBytes` null until the source reports a size |
| `pct` | 0-99 while running (null if size unknown), 100 when done |
| `waiting_for` | `queue` (queued behind a running job), `viewer` (paused, or queued and next, while someone is watching or within the resume grace), `window` (only with the opt-in window: queued, window closed), else null |
| `error`, `createdAt`, `finishedAt` | |

`window`: `{ enabled, open, startHour, endHour, tz }`. Default (no window):
`{ enabled: false, open: true, startHour: null, endHour: null, tz }`. Client
copy: "Starts now (pauses while someone's watching)"; only say "overnight"
when `enabled && !open`.

`jobs`, `window` (incl. `enabled`), `totalBytes`, `pct`, `waiting_for` are additive; older
clients ignore them.
