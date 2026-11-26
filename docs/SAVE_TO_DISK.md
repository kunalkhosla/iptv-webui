# Save to Disk

Owner-only: queue a highest-quality copy (stream copy, no re-encode) of an
IPTV movie or of series episodes onto the server's Disk library
(`<disk root>/Downloads/`). Web: the detail page's Disk menu. Android phone:
"Save to home server (Disk)" on movie / series detail (owner account, adult
profile). Not the phone's offline 720p "Download".

Jobs run one at a time, only inside the overnight window
(`DISK_DOWNLOAD_WINDOW_START_HOUR`..`END_HOUR`, `DISK_DOWNLOAD_WINDOW_TZ`,
default 1-6 AM America/New_York), and pause whenever a viewer holds the
household's single IPTV stream slot.

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

`GET /api/disk-download/jobs` -> `{ jobs: [job...newest first, max 100], window }`

job:

| field | meaning |
|---|---|
| `id` | job id (`jobIds` entry) |
| `mode`, `sourceId` | `movie` + stream id, or `series` + episode id |
| `status` | `queued` / `downloading` / `paused` / `done` / `failed` |
| `title`, `seriesTitle`, `season`, `episodeNum` | display |
| `bytesWritten`, `totalBytes` | progress; `totalBytes` null until the source reports a size |
| `pct` | 0-99 while running (null if size unknown), 100 when done |
| `waiting_for` | `window` (queued, window closed), `queue` (queued behind a running job), `viewer` (paused, someone is watching), else null |
| `error`, `createdAt`, `finishedAt` | |

`window`: `{ open, startHour, endHour, tz }`.

`jobs`, `window`, `totalBytes`, `pct`, `waiting_for` are additive; older
clients ignore them.
