# New episodes, Notify me, Continue Watching removal

Server contract for three per-profile browse features. All routes need the
normal session (cookie or Basic auth). Fields are additive: older clients
ignore them.

## 1. Remove one title from Continue Watching

`DELETE /api/user-state/recents/:mode/:id` (`mode` = movie | series | live | disk)
removes the title from `recents[mode]` and drops its saved position
(`progress[mode:id]`). For a **series** (`id` = series id) it also drops the
position of the episode its `lastEpisode` pointer names, clears the pointer's
up-next flag (`auto`) and stamps `cwRemovedAt`: a `PUT /api/user-state`
carrying the same episode with no newer `when` can't bring it back (a
different episode is a new play), and the show stops being followed for new
episodes until it is played again. The pointer itself stays (Resume and
Recently Watched still know the show). Idempotent; `{ ok: true }`.

Clients: web (the ✕ on each Continue Watching tile), TV (long-press OK on a
tile: "Remove from Continue Watching"), phone (long-press: the same menu).
Each removes the tile from its copy of the home payload at once; focus on TV
goes to the neighbouring tile, else the next row.

## 2. New episodes

Followed series = a `lastEpisode` pointer played in the last 120 days (pointer
`when`, the server's `playedAt` stamp, or that episode's progress `t`; a
pointer with none of them is not
followed, nor one removed from Continue Watching and not played since), still
in the catalog, at most 30 per profile, owner panel profiles only.

- **Polling**: every 6 h (first run 12 min after boot) each followed series'
  `get_series_info` is re-read through a prewarm queue: API calls only, never
  a stream; one call at a time with a 5 s gap; paused while anyone is
  watching (`streamingNow`); failures back off (20 min per series, 10 min
  pause after 5 in a row; an empty answer keeps the good copy and is not a
  failure). A copy fetched in the last 6 h (any detail open counts) is
  reused; a fresh read replaces the in-memory info copy (and the on-disk
  stale-if-error copy when that is older than 6 h). Anything that drops the
  info cache (panel switch, Refresh) re-runs the crawl 2 min later. `POST /api/admin/check-new-episodes` (owner) runs it now.
- **Seen mark** (`userState.seriesSeen[seriesId] = { s, e, at }`, server
  owned, never taken from `PUT /api/user-state`): the last (season, episode)
  the panel listed when the profile last **opened** the series
  (`GET /api/series/info/:id`, not a stale copy served while the panel
  fails) or **played** it (`GET /api/stream/series/...
  ?series=` or a progress post for the pointed episode, at most every
  10 min; both also stamp the pointer's server-owned `playedAt`). The mark only moves forward. The first poll of a followed series
  without a mark sets it (no flood of "new" on day one). Marks of series no
  longer followed are dropped after 120 days (at most 100 kept).
- **New** = episodes listed after the mark (specials sort first, so a new
  special never counts). Computed at request time from cached infos only.

`/api/home/series`:

- every series tile carries `new_episodes: N` when N > 0 (omitted otherwise);
- a `"New episodes"` rail (`category_id: "__rail-new-episodes"`, right after
  Continue Watching), newest new episode first (panel `added`), with
  `pickReason` "New: S2 E5" or "3 new episodes". Kid profiles see only tiles
  with an allowed certificate (the strict hero / Continue Watching rule).

Opening or playing the series clears both (the next home fetch). Clients:
badge "New episode" / "N new episodes" on series tiles; web also drops the
badge / rail tile at once when the series is opened.

## 3. Notify me when it lands on Khouch

Per profile list of TMDB titles the catalog doesn't carry
(`userState.notifyMe`, server owned; `/api/bootstrap` sends it as `[E]`,
`seriesSeen` is not sent). Adult profiles only (kid profiles get
403 / empty lists).

- `GET /api/notify-me` -> `{ items: [E] }`
- `POST /api/notify-me` `{ tmdb_id, kind: "movie" | "tv", title, year?, poster? }`
  -> `{ items }`. `409 { error: "in_catalog", mode, id }` when the catalog
  has it already (open that instead). `429` when full (200 entries; landed
  ones make room).
- `DELETE /api/notify-me/:kind/:tmdbId` -> `{ items }`
- `E = { tmdb_id, kind, title, year, poster, added_at, landed: null | { mode, id, at } }`

Where non-catalog titles surface (adults only):

- `GET /api/search/elsewhere?q=` -> `{ q, results: [C] }`: TMDB multi-search,
  movies + shows with a poster that the catalog lacks, top 10.
- `GET /api/person/credits` adds `elsewhere: { movie: [C], series: [C] }`:
  the person's 12 most popular credits per kind the catalog lacks (talk /
  news shows and self appearances skipped), `character` set.
- `GET /api/tmdb-title/:kind/:tmdbId` -> `C` plus `genres`, `runtime`,
  `seasons`, `in_catalog: null | { mode, id }`: the title page.
- `C = { tmdb_id, kind, title, year, date, poster, backdrop, overview, rating, notify }`
  (`notify` = on this profile's list and not landed yet).

**Matching**: after every catalog variant pass (index build, TMDB backfill)
and every 30 min, pending entries are matched against each profile's account
catalog by TMDB id (`ix.byTmdb`; a catalog title matched to the other TMDB
kind never counts). Kid profiles are skipped. A match sets `landed` once and:

- pushes through Home Assistant like programme reminders (docs/REMINDERS.md):
  only owner-account profiles of the owner user, service from
  `HA_NOTIFY_PROFILES` / `HA_NOTIFY_SERVICE`, tag
  `khouch-notify-<kind>-<tmdb_id>`, group `khouch-notify`. Others: no push.
  Log `[notify-me] ... landed ... push=<service|none>`.
- shows in a `"Now on Khouch"` rail (`category_id: "__rail-now-on-khouch"`)
  on `/api/home/movie` / `/api/home/series` for 21 days, newest first.
  Landed entries stay in the list 60 days.

`POST /api/admin/check-notify-me` (owner) runs the match now.

Clients: web (search + person "Not on Khouch yet" sections, a title card with
Notify me, Settings > "Notify me list…"), TV (person page row, title dialog,
Settings > Notify me list), phone (search + person rows, title sheet,
Settings > Notify me list).
